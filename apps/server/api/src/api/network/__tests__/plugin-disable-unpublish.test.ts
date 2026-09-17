import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import type { NetworkAddress } from "@internal/pane-runtime";
import { getNetworkPlugin } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import {
  deleteUserByEmailOrId,
  seedLocalPluginsForTests,
  setupAuthTables,
  signIn,
} from "@/api/__tests__/helpers/auth-tables.js";
import { beginNetworkOp, endNetworkOp } from "@/api/network/network-gate.js";
import { pluginsRoutes } from "@/api/plugins.route.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  isNetworkPluginTombstoned,
  observeNetworkStatus,
  setNetworkOriginsResolveForTests,
} from "@/services/network/origins.js";
import { clearNetworkState, networkStatePath, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { setUnpublishDepsForTests } from "@/services/network/unpublish.js";
import { installLocalPlugin } from "@/services/nodes/local-plugins.js";
import { originRegistry, resetOriginRegistryForTests } from "@/services/trusted-origins.js";

/**
 * `PATCH /api/plugins/:id { enabled: false }` on a NETWORK plugin runs the
 * unpublish sequence first (spec 2026-09-15 § 5.1, last row).
 *
 * "Disable" has to be a real stop rather than a request. The host owns the
 * tunnel process and the request guard, so flipping the flag while both are
 * live would leave a `public-with-gate` hostname serving traffic that nothing
 * in the UI still claims to be publishing — and a failure to stop it REFUSES
 * the disable, keeping the row, the Networking page and the running tunnel
 * describing the same machine.
 *
 * Driven against the real installed store rather than a fake: the branch keys
 * on the store's own reported `type`, so a test that injected the type would
 * not be testing the thing that decides.
 */

const app = new Elysia().use(errorHandlerPlugin).use(pluginsRoutes);

/** A built-in NETWORK plugin, which boot seeds into the instance store. */
const NETWORK_PLUGIN_ID = "tailscale";
/** A built-in HARNESS plugin, to prove the branch is keyed on the type. */
const HARNESS_PLUGIN_ID = "terminal";

const adminEmail = `plugin-disable-admin-${crypto.randomUUID()}@subshell.local`;
const password = "plugin-disable-pass-1234";
let adminCookie = "";

function patch(id: string, enabled: boolean): Request {
  return new Request(`http://localhost:3080/api/plugins/${id}`, {
    method: "PATCH",
    headers: { cookie: `better-auth.session_token=${adminCookie}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

describe("disabling a network plugin", () => {
  beforeAll(async () => {
    await setupAuthTables();
    await seedLocalPluginsForTests();
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);
  });

  afterEach(async () => {
    setUnpublishDepsForTests(null);
    resetOriginRegistryForTests();
    await new PluginStateRepository(db).clear(NETWORK_PLUGIN_ID);
    await new PluginStateRepository(db).clear(HARNESS_PLUGIN_ID);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(adminEmail);
  });

  it("answers 409 while another act holds the plugin's lock, writing nothing", async () => {
    // The per-plugin lock every `/api/network` act takes: a disable must not
    // interleave with a live publish's record write. The refusal must also
    // leave the flag ALONE: a 409 that disabled anyway would be the flag
    // lying about a tunnel that is still up.
    const calls: string[] = [];
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        calls.push("disarm");
      },
      lastLines: () => [],
      setPluginGuards: () => {},
    });
    expect(beginNetworkOp(NETWORK_PLUGIN_ID)).toBe(true);
    try {
      const res = await app.fetch(patch(NETWORK_PLUGIN_ID, false));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("EXISTS_ERROR");
      expect(body.message).toContain("already running");
    } finally {
      endNetworkOp(NETWORK_PLUGIN_ID);
    }
    expect(calls).toEqual([]);
    expect((await new PluginStateRepository(db).stateByPluginId()).get(NETWORK_PLUGIN_ID)).not.toBe(false);
    // And the same request runs the moment the lock frees.
    const freed = await app.fetch(patch(NETWORK_PLUGIN_ID, false));
    expect(freed.status).toBe(200);
    expect(calls).toEqual(["disarm"]);
  });

  it("forgets the plugin's origins and clears its addresses on disable", async () => {
    // The reviewer's non-vacuity demand, one registry later: a disable must
    // take down the trust as well as the process. The seed is a plugin the
    // registry DOES trust — without it, every case here would pass on an
    // already-empty set and prove nothing.
    originRegistry().setPluginOrigins(NETWORK_PLUGIN_ID, ["https://nb.example"]);
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {},
      lastLines: () => [],
      setPluginGuards: () => {},
    });
    await writeNetworkState(NETWORK_PLUGIN_ID, {
      published: true,
      port: 3080,
      addresses: [{ url: "https://nb.example", scheme: "http", label: "IP", secureContext: false }],
    });

    expect((await app.fetch(patch(NETWORK_PLUGIN_ID, false))).status).toBe(200);
    // A disabled network trusts nothing (spec § 10f), and its record's
    // addresses are cleared: a re-enable starts from an empty set until the
    // next probe re-learns them.
    expect(originRegistry().pluginOrigins(NETWORK_PLUGIN_ID)).toEqual([]);
    const state = await readNetworkState(NETWORK_PLUGIN_ID);
    expect(state.published).toBe(false);
    expect(state.addresses).toEqual([]);
    await clearNetworkState(NETWORK_PLUGIN_ID);
  });

  it("unpublishes before the flag is written", async () => {
    const order: string[] = [];
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        // Read the flag from INSIDE the sequence: the whole point is that it
        // is still enabled while the tunnel is being taken down.
        const state = await new PluginStateRepository(db).stateByPluginId();
        order.push(`disarm(enabled=${state.get(NETWORK_PLUGIN_ID) !== false})`);
      },
      lastLines: () => [],
      setPluginGuards: () => {},
    });

    const res = await app.fetch(patch(NETWORK_PLUGIN_ID, false));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(order).toEqual(["disarm(enabled=true)"]);
  });

  it("refuses the disable when the unpublish fails, leaving the plugin enabled", async () => {
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        throw new Error("the tunnel would not stop");
      },
      lastLines: () => ["cloudflared: still connected"],
      setPluginGuards: () => {},
    });

    const res = await app.fetch(patch(NETWORK_PLUGIN_ID, false));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("the tunnel would not stop");
    expect(body.message).toContain("cloudflared: still connected");
    // Still enabled. A row saying "off" beside a live tunnel is the state
    // this refusal exists to prevent.
    const state = await new PluginStateRepository(db).stateByPluginId();
    expect(state.get(NETWORK_PLUGIN_ID)).not.toBe(false);
  });

  it("does not run the sequence when ENABLING a network plugin", async () => {
    let disarms = 0;
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        disarms += 1;
      },
      lastLines: () => [],
      setPluginGuards: () => {},
    });
    const res = await app.fetch(patch(NETWORK_PLUGIN_ID, true));
    expect(res.status).toBe(200);
    expect(disarms).toBe(0);
  });

  it("does not run the sequence for a harness plugin", async () => {
    let disarms = 0;
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        disarms += 1;
      },
      lastLines: () => [],
      setPluginGuards: () => {},
    });
    const res = await app.fetch(patch(HARNESS_PLUGIN_ID, false));
    expect(res.status).toBe(200);
    expect(disarms).toBe(0);
  });
});

const joinedAddress: NetworkAddress = {
  url: "http://100.64.0.9:3080",
  scheme: "http",
  label: "Tailscale IP",
  secureContext: false,
};

function patchUninstall(id: string): Request {
  return new Request(`http://localhost:3080/api/plugins/${id}`, {
    method: "DELETE",
    headers: { cookie: `better-auth.session_token=${adminCookie}` },
  });
}

describe("uninstalling a network plugin", () => {
  // The finding: BOTH shipped guards structurally miss a BUILT-IN's
  // uninstall — `getNetworkPlugin` answers the compiled set forever, and the
  // row is cleared, whose absent default is enabled. The tombstone is the
  // state that survives both, and these cases pin that the ROUTE declares
  // it (inside the lock, before the forget) and that the observation honors
  // it for a probe whose `status()` spanned the uninstall.

  beforeAll(async () => {
    // The disable suite's afterAll DELETED the admin when that describe
    // completed (bun runs afterAll per-describe), so this one mints its own
    // session over the same fixture path.
    await setupAuthTables();
    await seedLocalPluginsForTests();
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);
  });

  beforeEach(() => {
    // Loadability PINNED true: whatever the tombstone refuses here,
    // resolvability provably did not. (The real registry answers built-ins
    // forever anyway — asserted below, after the bytes are gone.)
    setNetworkOriginsResolveForTests(() => true);
  });

  afterEach(() => {
    setNetworkOriginsResolveForTests(null);
    setUnpublishDepsForTests(null);
    resetOriginRegistryForTests();
    void clearNetworkState(NETWORK_PLUGIN_ID);
  });

  afterAll(async () => {
    // Restore the built-in's copy for the rest of the run — through the
    // production installer, which is also what lifts the tombstone
    // (`installLocalPlugin`), pinning the reinstall half of the contract.
    await installLocalPlugin(NETWORK_PLUGIN_ID);
    expect(isNetworkPluginTombstoned(NETWORK_PLUGIN_ID)).toBe(false);
    await deleteUserByEmailOrId(adminEmail);
  });

  it("refuses leave the plugin undeclared: a failed stop 409s before the tombstone", async () => {
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {
        throw new Error("the tunnel would not stop");
      },
      lastLines: () => ["tailscale: still up"],
      setPluginGuards: () => {},
    });
    const res = await app.fetch(patchUninstall(NETWORK_PLUGIN_ID));
    expect(res.status).toBe(409);
    expect(isNetworkPluginTombstoned(NETWORK_PLUGIN_ID)).toBe(false);
  });

  it("tombstones the built-in the bytes went with, and an observation that spanned the uninstall relearns nothing", async () => {
    setUnpublishDepsForTests({
      getPlugin: () => undefined,
      disarm: async () => {},
      lastLines: () => [],
      setPluginGuards: () => {},
    });
    // A plugin the registry DOES trust and the record DOES describe, so
    // "refuses" has a non-empty thing to protect (the non-vacuity demand).
    originRegistry().setPluginOrigins(NETWORK_PLUGIN_ID, [joinedAddress.url]);
    await writeNetworkState(NETWORK_PLUGIN_ID, { published: false, addresses: [joinedAddress] });
    const status = { state: "joined" as const, addresses: [joinedAddress], hints: [] };

    // The probe already in flight, whose read spanned the whole uninstall:
    // started before the DELETE, awaited after it. Its fingerprint matches
    // the record, so it cannot be the writer racing the route's own file
    // clear — the only writer under test is the guarded one below.
    const inFlight = observeNetworkStatus(NETWORK_PLUGIN_ID, { exposure: "private" }, status);
    const res = await app.fetch(patchUninstall(NETWORK_PLUGIN_ID));
    expect(res.status).toBe(200);
    await inFlight;

    // The declaration landed — and neither other guard could have:
    expect(isNetworkPluginTombstoned(NETWORK_PLUGIN_ID)).toBe(true);
    expect(getNetworkPlugin(NETWORK_PLUGIN_ID)).toBeDefined(); // compiled set, bytes gone
    expect(await new PluginStateRepository(db).isEnabled(NETWORK_PLUGIN_ID)).toBe(true); // row cleared

    // The in-flight probe that OBSERVES AFTER the uninstall (the refresher's
    // real shape: capture pre-uninstall, a seconds-long status(), observe
    // post-uninstall) must recreate neither the record nor the trust.
    await observeNetworkStatus(NETWORK_PLUGIN_ID, { exposure: "private" }, status);
    expect(existsSync(networkStatePath(NETWORK_PLUGIN_ID))).toBe(false);
    expect(originRegistry().pluginOrigins(NETWORK_PLUGIN_ID)).toEqual([]);
  });
});
