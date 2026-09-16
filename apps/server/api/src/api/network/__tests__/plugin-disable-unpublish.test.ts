import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import {
  deleteUserByEmailOrId,
  seedLocalPluginsForTests,
  setupAuthTables,
  signIn,
} from "@/api/__tests__/helpers/auth-tables.js";
import { beginNetworkOp, endNetworkOp, setNetworkDepsForTests } from "@/api/network/network-gate.js";
import { pluginsRoutes } from "@/api/plugins.route.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { clearNetworkState, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { setUnpublishDepsForTests } from "@/services/network/unpublish.js";
import { type ConfigRecorder, fakeDeps, makeFakePlugin } from "./fake-network-plugin.js";

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
    await new PluginStateRepository(db).clear(NETWORK_PLUGIN_ID);
    await new PluginStateRepository(db).clear(HARNESS_PLUGIN_ID);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(adminEmail);
  });

  it("answers 409 while another act holds the plugin's lock, writing nothing", async () => {
    // The strip disable runs is the same config.env write a `/api/network`
    // act holds its per-plugin lock for; without taking that lock, a disable
    // could race a live publish's union — two writers, last rename wins, and
    // neither result describes the file afterwards. The refusal must also
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

  it("runs the origin strip for a recorded publish, through the gate's writer", async () => {
    // The reviewer's non-vacuity demand: with no publish record the sequence
    // never reaches `removePublishedConfig`, so every other case in this file
    // passes without touching the subtraction at all. Here the record is
    // real, so the disable's quiet strip must actually rewrite the file —
    // through the gate's ONE writer, not a local stub.
    const config: ConfigRecorder = {
      calls: [],
      result: {
        ok: true,
        path: "/tmp/config.env",
        values: {},
        warnings: [],
        changed: [
          { key: "TRUSTED_ORIGINS", from: "http://localhost:3080,https://nb.example", to: "http://localhost:3080" },
        ],
      },
    };
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(
      fakeDeps(entry, {
        config,
        configValues: () => ({ TRUSTED_ORIGINS: "http://localhost:3080,https://nb.example" }),
      }),
    );
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
    expect(config.calls).toEqual([{ trustedOrigins: "http://localhost:3080" }]);
    // The record cleared, the origins subtracted: the disable really did
    // stop describing this machine as published on the network.
    expect((await readNetworkState(NETWORK_PLUGIN_ID)).published).toBe(false);
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
