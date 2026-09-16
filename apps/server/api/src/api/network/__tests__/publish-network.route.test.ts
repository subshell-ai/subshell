import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { RequestGuardSpec } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { networkRoutes } from "@/api/network/index.js";
import { invalidateNetworkStatus, setNetworkDepsForTests, unionOrigins } from "@/api/network/network-gate.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { activeAccessGuards, setAccessGuards } from "@/plugins/access-guard.plugin.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { clearNetworkState, readNetworkState } from "@/services/network/state.js";
import { type ConfigRecorder, FAKE_ID, fakeDeps, makeFakePlugin } from "./fake-network-plugin.js";

/**
 * `POST /api/network/:id/publish` (spec 2026-09-15 § 5.1, § 5.4).
 *
 * Its own file because publishing is the route that does four things in one
 * act — install a guard, arm a process, record the publish, rewrite the config
 * — and the ORDER and the CONFIG RULES are the properties worth pinning:
 *
 * - the guard is installed before anything can carry traffic;
 * - `TRUSTED_ORIGINS` is a union, never a replacement;
 * - a key the environment owns is not written, and the publish still stands.
 */

const app = new Elysia().use(errorHandlerPlugin).use(networkRoutes);

const adminEmail = `network-publish-admin-${crypto.randomUUID()}@subshell.local`;
const password = "network-publish-pass-1234";
let adminCookie = "";

function withCookie(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("cookie", `better-auth.session_token=${adminCookie}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

async function frames(res: Response): Promise<Record<string, any>[]> {
  return (await res.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** The terminal frame of a stream. */
async function doneFrame(res: Response): Promise<Record<string, any>> {
  const emitted = await frames(res);
  return emitted[emitted.length - 1];
}

const GUARD: RequestGuardSpec = {
  kind: "cloudflare-access",
  hostname: "server.example.com",
  teamDomain: "team.cloudflareaccess.com",
  aud: "aud-1",
};

const ADDRESSES = [
  { url: "https://server.example.com", scheme: "https" as const, label: "Cloudflare", secureContext: true },
];

function recorder(): ConfigRecorder {
  return {
    calls: [],
    result: {
      ok: true,
      path: "/tmp/config.env",
      values: {},
      warnings: ["a warning the CLI writer produced"],
      changed: [{ key: "TRUSTED_ORIGINS", from: undefined, to: "https://server.example.com" }],
    },
  };
}

describe("POST /api/network/:id/publish", () => {
  beforeAll(async () => {
    await setupAuthTables();
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);
  });

  afterEach(async () => {
    setNetworkDepsForTests(null);
    setAccessGuards([]);
    invalidateNetworkStatus();
    await clearNetworkState(FAKE_ID);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(adminEmail);
  });

  it("installs the guard, records the publish and unions the origins", async () => {
    const config = recorder();
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES, guard: GUARD } });
    setNetworkDepsForTests(
      fakeDeps(entry, { config, configValues: () => ({ TRUSTED_ORIGINS: "http://localhost:3080" }) }),
    );

    const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");

    const done = await doneFrame(res);
    expect(done.type).toBe("done");
    expect(done.ok).toBe(true);
    expect(done.addresses).toEqual(ADDRESSES);
    expect(done.restartRequired).toBe(true);
    expect(done.config.written).toBe(true);
    expect(done.config.changed).toEqual(["TRUSTED_ORIGINS"]);
    expect(done.config.warnings).toContain("a warning the CLI writer produced");

    // The guard is live, and the existing origin survived the union.
    expect(activeAccessGuards()).toEqual([GUARD]);
    expect(config.calls).toEqual([{ trustedOrigins: "http://localhost:3080,https://server.example.com" }]);

    const state = await readNetworkState(FAKE_ID);
    expect(state.published).toBe(true);
    expect(state.port).toBe(3080);
    expect(state.addresses).toEqual(ADDRESSES);
  });

  it("replaces only its own hostname in the guard set", async () => {
    const other: RequestGuardSpec = { ...GUARD, hostname: "someone-else.example.com" };
    setAccessGuards([other]);
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES, guard: GUARD } });
    setNetworkDepsForTests(fakeDeps(entry, { config: recorder() }));
    await frames(await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })));
    expect(activeAccessGuards().map((g) => g.hostname)).toEqual(["someone-else.example.com", "server.example.com"]);
  });

  it("answers a plugin's refusal as a done frame, not an error", async () => {
    // A refusal is an ANSWER: the act completed and told us what the operator
    // has to do first. An `error` frame would say the server broke.
    const config = recorder();
    const { entry } = makeFakePlugin({
      publish: { refused: { text: "Enable HTTPS on your tailnet first.", docsUrl: "https://example.invalid" } },
    });
    setNetworkDepsForTests(fakeDeps(entry, { config }));
    const done = await doneFrame(
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })),
    );
    expect(done.type).toBe("done");
    expect(done.ok).toBe(false);
    expect(done.refused.text).toBe("Enable HTTPS on your tailnet first.");
    expect(done.addresses).toEqual([]);
    expect(done.restartRequired).toBe(false);
    // Vacuously written: nothing was asked of config.env, so nothing failed.
    expect(done.config).toEqual({ changed: [], warnings: [], written: true });
    expect(config.calls).toEqual([]);
    expect(activeAccessGuards()).toEqual([]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(false);
  });

  it("does not write a key the environment owns, and publishes anyway", async () => {
    // The server really IS reachable at the address; what could not follow is
    // the file. Reporting a refusal here would be reporting a failure for an
    // act that succeeded.
    const config = recorder();
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES, guard: GUARD } });
    setNetworkDepsForTests(
      fakeDeps(entry, {
        config,
        env: () => ({ TRUSTED_ORIGINS: "http://localhost:3080" }),
        configValues: () => ({}),
      }),
    );
    const done = await doneFrame(
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })),
    );
    expect(done.ok).toBe(true);
    expect(done.config.written).toBe(false);
    expect(done.config.unwritableKey).toBe("TRUSTED_ORIGINS");
    expect(config.calls).toEqual([]);
    expect(activeAccessGuards()).toEqual([GUARD]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(true);
  });

  it("refuses to publish a public-with-gate network that describes no guard", async () => {
    // The host is the enforcement point by this design's own rule, so a plugin
    // that reaches the open internet and hands back no identity check may not
    // be taken at its word. Nothing is armed before this point, so the refusal
    // leaves the machine exactly as it was — and it is a refusal (an answer)
    // rather than an error, so it carries a hint instead of a status code.
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "public-with-gate" });
    setNetworkDepsForTests(fakeDeps(entry));
    const done = await doneFrame(
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: JSON.stringify({}) })),
    );
    expect(done.ok).toBe(false);
    expect(done.refused.text).toContain("public internet");
    expect(done.addresses).toEqual([]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(false);
  });

  it("promotes APP_BASE_URL only when asked, and warns about the rpID move", async () => {
    const config = recorder();
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "private" });
    setNetworkDepsForTests(fakeDeps(entry, { config }));
    const done = await doneFrame(
      await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/publish`, {
          method: "POST",
          body: JSON.stringify({ promoteBaseUrl: true }),
        }),
      ),
    );
    expect(done.ok).toBe(true);
    expect(config.calls).toEqual([
      { trustedOrigins: "https://server.example.com", baseUrl: "https://server.example.com" },
    ]);
    expect(done.config.warnings.some((w: string) => w.includes("passkey rpID"))).toBe(true);
  });

  it("leaves APP_BASE_URL alone by default", async () => {
    const config = recorder();
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "private" });
    setNetworkDepsForTests(fakeDeps(entry, { config }));
    await frames(await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })));
    expect(config.calls[0]?.baseUrl).toBeUndefined();
  });

  it("keeps the publish when the config writer refuses the value", async () => {
    const config = recorder();
    config.result = { ok: false, kind: "invalid", key: "TRUSTED_ORIGINS", reason: "that is not an origin" };
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "private" });
    setNetworkDepsForTests(fakeDeps(entry, { config }));
    const done = await doneFrame(
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })),
    );
    expect(done.ok).toBe(true);
    expect(done.config.written).toBe(false);
    expect(done.config.warnings.some((w: string) => w.includes("that is not an origin"))).toBe(true);
    expect((await readNetworkState(FAKE_ID)).published).toBe(true);
  });

  it("delivers a throwing publish as an error frame inside a 200", async () => {
    const { entry } = makeFakePlugin({ publish: { throws: "the tunnel API said no" } });
    setNetworkDepsForTests(fakeDeps(entry, { config: recorder() }));
    const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    const done = await doneFrame(res);
    expect(done.type).toBe("error");
    expect(done.message).toContain("the tunnel API said no");
    expect(activeAccessGuards()).toEqual([]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(false);
  });

  it("audits the addresses and whether a base URL was promoted", async () => {
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "private" });
    setNetworkDepsForTests(fakeDeps(entry, { config: recorder() }));
    await frames(
      await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/publish`, {
          method: "POST",
          body: JSON.stringify({ promoteBaseUrl: true }),
        }),
      ),
    );
    const events = await new AuditRepository(db).listLatest(300);
    const row = events.find((e) => e.action === "network.publish");
    expect(row).toBeDefined();
    expect(JSON.parse(String(row?.metadataJson ?? "{}"))).toEqual({
      addresses: ["https://server.example.com"],
      promotedBaseUrl: "https://server.example.com",
    });
  });

  describe("unionOrigins", () => {
    it("canonicalizes both sides and never drops what was already there", () => {
      expect(
        unionOrigins("https://a.example/ , http://b.example:80", ["https://a.example", "https://c.example"]),
      ).toEqual(["https://a.example", "http://b.example", "https://c.example"]);
    });

    it("carries an unparseable stored entry through verbatim", () => {
      // The validator inside `applyConfig` is what decides whether a stored
      // value is acceptable; silently deleting a line an operator hand-wrote
      // is not this function's call.
      expect(unionOrigins("not-a-url", ["https://a.example"])).toEqual(["not-a-url", "https://a.example"]);
    });
  });
});
