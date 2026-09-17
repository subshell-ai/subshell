import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { RequestGuardSpec } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { networkRoutes } from "@/api/network/index.js";
import { invalidateNetworkStatus, setNetworkDepsForTests } from "@/api/network/network-gate.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { activeAccessGuards, setAccessGuards } from "@/plugins/access-guard.plugin.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { clearNetworkState, readNetworkState } from "@/services/network/state.js";
import { originRegistry, resetOriginRegistryForTests } from "@/services/trusted-origins.js";
import { FAKE_ID, fakeDeps, makeFakePlugin } from "./fake-network-plugin.js";

/**
 * `POST /api/network/:id/publish` (spec 2026-09-15 § 5.1, § 5.4).
 *
 * Its own file because publishing is the route that does three things in one
 * act — install a guard, arm a process, record the publish — and the ORDER
 * and the TRUST RULES are the properties worth pinning:
 *
 * - the guard is installed before anything can carry traffic;
 * - the record is what the origin registry follows — nothing is written to
 *   config.env, and a `public-with-gate` address becomes trusted only from a
 *   published record;
 * - a plugin refusal is an answer (a done frame), never a failure.
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
    resetOriginRegistryForTests();
    await clearNetworkState(FAKE_ID);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(adminEmail);
  });

  it("installs the guard and records the publish, and the registry trusts the addresses", async () => {
    // The status agrees with the publish result, as it does for every real
    // plugin: the post-write fresh re-read is now an OBSERVATION (task S4),
    // so a fake whose status disagreed with what `publish()` returned would
    // end with the record re-learned from the status rather than the result.
    const { entry } = makeFakePlugin({
      publish: { addresses: ADDRESSES },
      status: { state: "published", addresses: ADDRESSES, hints: [] },
      guard: GUARD,
    });
    setNetworkDepsForTests(fakeDeps(entry));

    const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");

    const done = await doneFrame(res);
    expect(done.type).toBe("done");
    expect(done.ok).toBe(true);
    expect(done.addresses).toEqual(ADDRESSES);
    // The done frame answers with the fresh status and nothing else.
    expect(done.config).toBeUndefined();
    expect(done.restartRequired).toBeUndefined();

    // The guard is live.
    expect(activeAccessGuards()).toEqual([{ pluginId: FAKE_ID, spec: GUARD }]);

    const state = await readNetworkState(FAKE_ID);
    expect(state.published).toBe(true);
    expect(state.port).toBe(3080);
    expect(state.addresses).toEqual(ADDRESSES);
    // The publish is trusted the moment it is recorded: `public-with-gate`
    // contributes only from a published record, and this record now says so.
    expect(originRegistry().pluginOrigins(FAKE_ID)).toEqual(["https://server.example.com"]);
  });

  it("replaces only its own hostname in the guard set", async () => {
    const other: RequestGuardSpec = { ...GUARD, hostname: "someone-else.example.com" };
    setAccessGuards([{ pluginId: "someone-else", spec: other }]);
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, guard: GUARD });
    setNetworkDepsForTests(fakeDeps(entry));
    await frames(await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })));
    expect(activeAccessGuards().map((g) => g.spec.hostname)).toEqual([
      "someone-else.example.com",
      "server.example.com",
    ]);
  });

  it("answers a plugin's refusal as a done frame, not an error", async () => {
    // A refusal is an ANSWER: the act completed and told us what the operator
    // has to do first. An `error` frame would say the server broke.
    const { entry } = makeFakePlugin({
      publish: { refused: { text: "Enable HTTPS on your tailnet first.", docsUrl: "https://example.invalid" } },
    });
    setNetworkDepsForTests(fakeDeps(entry));
    const done = await doneFrame(
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })),
    );
    expect(done.type).toBe("done");
    expect(done.ok).toBe(false);
    expect(done.refused.text).toBe("Enable HTTPS on your tailnet first.");
    expect(done.addresses).toEqual([]);
    expect(done.config).toBeUndefined();
    expect(done.restartRequired).toBeUndefined();
    expect(activeAccessGuards()).toEqual([]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(false);
    // A refused publish records nothing, and the registry follows the record.
    expect(originRegistry().pluginOrigins(FAKE_ID)).toEqual([]);
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

  it("delivers a throwing publish as an error frame inside a 200", async () => {
    const { entry } = makeFakePlugin({ publish: { throws: "the tunnel API said no" } });
    setNetworkDepsForTests(fakeDeps(entry));
    const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    const done = await doneFrame(res);
    expect(done.type).toBe("error");
    expect(done.message).toContain("the tunnel API said no");
    expect(activeAccessGuards()).toEqual([]);
    expect((await readNetworkState(FAKE_ID)).published).toBe(false);
  });

  it("audits the addresses, and nothing else", async () => {
    const { entry } = makeFakePlugin({ publish: { addresses: ADDRESSES }, exposure: "private" });
    setNetworkDepsForTests(fakeDeps(entry));
    await frames(await app.fetch(withCookie(`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" })));
    const events = await new AuditRepository(db).listLatest(300);
    const row = events.find((e) => e.action === "network.publish");
    expect(row).toBeDefined();
    expect(JSON.parse(String(row?.metadataJson ?? "{}"))).toEqual({
      addresses: ["https://server.example.com"],
    });
  });
});
