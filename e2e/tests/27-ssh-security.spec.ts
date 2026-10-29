import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { missingSshBins, type SshFixture, startSshFixture } from "../fixtures/sshd";
import { BASE_URL } from "../ports";
import { ADMIN, ADMIN_STATE } from "./helpers";

// These requests reach the running server and a real sshd. No server internals
// or injected policy hooks are involved; spec 25 supplies the successful signer.
const missing = missingSshBins();
test.skip(missing.length > 0, `Live SSH probes require ${missing.join(", ")}`);
let root: string;
let fixture: SshFixture;
let admin: APIRequestContext;
let otherLogin: APIRequestContext;
let guest: APIRequestContext;
let bearer: APIRequestContext;
let anonymous: APIRequestContext;
let destination: string;
const preparations: string[] = [];
const panes: string[] = [];

test.beforeAll(async ({ playwright }) => {
  root = mkdtempSync(path.join(tmpdir(), "ssh-adversarial-"));
  fixture = await startSshFixture(root);
  destination = `${fixture.user}@127.0.0.1:${fixture.port}`;
  admin = await playwright.request.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE });
  otherLogin = await playwright.request.newContext({ baseURL: BASE_URL });
  guest = await playwright.request.newContext({ baseURL: BASE_URL });
  anonymous = await playwright.request.newContext({ baseURL: BASE_URL });
  expect((await otherLogin.post("/api/auth/sign-in/email", { data: ADMIN })).ok()).toBe(true);
  const account = {
    name: "SSH adversary",
    email: `ssh-adversary-${randomUUID()}@audit.test`,
    password: randomUUID(),
    role: "user",
  };
  expect((await admin.post("/api/users", { data: account })).ok()).toBe(true);
  expect((await guest.post("/api/auth/sign-in/email", { data: account })).ok()).toBe(true);
  const keyResponse = await admin.post("/api/system-keys", {
    data: { name: "SSH bearer probe", permissions: ["subshells:read", "subshells:execute"] },
  });
  expect(keyResponse.ok()).toBe(true);
  bearer = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { authorization: `Bearer ${(await keyResponse.json()).key}` },
  });
  expect((await admin.put("/api/nodes/local/ssh-enabled", { data: { on: true } })).ok()).toBe(true);
});

test.afterEach(async () => {
  for (const id of preparations.splice(0)) expect((await admin.delete(`/api/ssh/local-key/${id}`)).ok()).toBe(true);
  for (const id of panes.splice(0)) expect((await admin.delete(`/api/subshells/${id}`)).ok()).toBe(true);
  if (admin) {
    const removed = await admin.delete(`/api/ssh/host-pins/${encodeURIComponent(destination)}`);
    expect([200, 404]).toContain(removed.status());
    expect((await admin.put("/api/nodes/local/ssh-enabled", { data: { on: true } })).ok()).toBe(true);
  }
});

test.afterAll(async () => {
  for (const context of [admin, otherLogin, guest, bearer, anonymous]) await context?.dispose();
  await fixture?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function prepareKey() {
  const response = await admin.post("/api/ssh/local-key", { data: { node: "local", destination } });
  expect(response.status()).toBe(200);
  const result = await response.json();
  preparations.push(result.id);
  return result.id as string;
}

async function launchKey(id: string, context = admin, target = destination) {
  const response = await context.post("/api/ssh/launch", {
    data: { node: "local", destination: target, localKeyId: id },
  });
  if (response.status() === 201) panes.push((await response.json()).subshell.id);
  return response;
}

test("SSH discovery, launch, trust and signing APIs reject anonymous and bearer actors", async () => {
  const id = randomUUID();
  const routes: { method: string; url: string; data?: unknown }[] = [
    ...["readiness", "aliases?node=local", "identities?node=local", "host-pins", "recent-destinations"].map((name) => ({
      method: "GET",
      url: `/api/ssh/${name}`,
    })),
    { method: "POST", url: "/api/ssh/resolve", data: { node: "local", alias: destination } },
    { method: "POST", url: "/api/ssh/launch", data: { node: "local", destination } },
    { method: "POST", url: "/api/ssh/local-key", data: { node: "local", destination } },
    { method: "POST", url: `/api/ssh/local-key/${id}/exchange`, data: {} },
    { method: "DELETE", url: `/api/ssh/local-key/${id}` },
    { method: "POST", url: "/api/ssh/verify-destination", data: { node: "local", keyHome: "local", destination } },
    { method: "POST", url: "/api/ssh/verify-destination/accept", data: { token: id } },
    { method: "POST", url: "/api/ssh/setup-here", data: { paneId: id } },
  ];
  expect((await bearer.get("/api/subshells")).status()).toBe(200);
  for (const route of routes) {
    const { url, ...options } = route;
    expect((await anonymous.fetch(url, options)).status(), `${route.method} ${url}, anonymous`).toBe(401);
    expect((await bearer.fetch(url, options)).status(), `${route.method} ${url}, bearer`).toBe(403);
  }
});

test("destination injection and changed approval cannot launch or execute a local command", async () => {
  const canary = path.join(root, "injected-command");
  const before = await (await admin.get("/api/subshells")).json();
  const valid = await admin.post("/api/ssh/resolve", { data: { node: "local", alias: destination } });
  expect(valid.status()).toBe(200);
  expect((await valid.json()).accepted).toBe(true);
  for (const target of [
    `-oProxyCommand=touch\t${canary}`,
    `${destination}\nProxyCommand touch ${canary}`,
    `$(touch\x24{IFS}${canary})`,
    `\x60touch\x24{IFS}${canary}\x60`,
  ]) {
    const response = await admin.post("/api/ssh/launch", { data: { node: "local", destination: target } });
    expect([400, 422], target).toContain(response.status());
  }
  const changed = await admin.post("/api/ssh/launch", {
    data: { node: "local", destination, expectedDestination: `different-user@127.0.0.1:${fixture.port}` },
  });
  expect(changed.status()).toBe(400);
  expect((await changed.json()).code).toBe("CONFIG_INVALID");
  expect(existsSync(canary)).toBe(false);
  const after = await (await admin.get("/api/subshells")).json();
  expect(after.map((row: { id: string }) => row.id)).toEqual(before.map((row: { id: string }) => row.id));
});

test("destination approval is account-bound, single-use and cannot replace a conflicting pin", async () => {
  const prepared = await admin.post("/api/ssh/verify-destination", {
    data: { node: "local", keyHome: "local", destination },
  });
  expect(prepared.status()).toBe(200);
  const challenge = await prepared.json();
  expect((await (await admin.get("/api/ssh/host-pins")).json()).pins).not.toContainEqual(
    expect.objectContaining({ destination }),
  );
  expect((await guest.post("/api/ssh/verify-destination/accept", { data: { token: challenge.token } })).status()).toBe(
    409,
  );
  expect((await admin.post("/api/ssh/verify-destination/accept", { data: { token: challenge.token } })).status()).toBe(
    200,
  );
  expect((await admin.post("/api/ssh/verify-destination/accept", { data: { token: challenge.token } })).status()).toBe(
    409,
  );
  const pins = (await (await admin.get("/api/ssh/host-pins")).json()).pins;
  const original = pins.find((pin: { destination: string }) => pin.destination === destination);
  expect(original).toBeDefined();
  expect((await (await guest.get("/api/ssh/host-pins")).json()).pins).toEqual([]);
  expect((await guest.delete(`/api/ssh/host-pins/${encodeURIComponent(destination)}`)).status()).toBe(404);
  const otherKey = readFileSync(`${fixture.trustedKeyPath}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const overwrite = await admin.post("/api/ssh/host-pins", {
    data: { destination, hostKey: `[127.0.0.1]:${fixture.port} ${otherKey}` },
  });
  expect(overwrite.status()).toBe(409);
  expect((await (await admin.get("/api/ssh/host-pins")).json()).pins).toContainEqual(original);
});

test("destination confirmation rechecks SSH access and consumes a refused approval", async () => {
  const prepared = await admin.post("/api/ssh/verify-destination", {
    data: { node: "local", keyHome: "local", destination },
  });
  expect(prepared.status()).toBe(200);
  const { token } = await prepared.json();
  expect((await admin.put("/api/nodes/local/ssh-enabled", { data: { on: false } })).ok()).toBe(true);
  expect((await admin.post("/api/ssh/verify-destination/accept", { data: { token } })).status()).toBe(403);
  expect((await admin.put("/api/nodes/local/ssh-enabled", { data: { on: true } })).ok()).toBe(true);
  expect((await admin.post("/api/ssh/verify-destination/accept", { data: { token } })).status()).toBe(409);
  expect((await (await admin.get("/api/ssh/host-pins")).json()).pins).not.toContainEqual(
    expect.objectContaining({ destination }),
  );
});

test("local-key handles resist another account, another login, destination changes and replay", async () => {
  const id = await prepareKey();
  expect((await launchKey(id, guest)).status()).toBe(409);
  expect((await launchKey(id, otherLogin)).status()).toBe(409);
  expect((await launchKey(id, admin, `different-user@127.0.0.1:${fixture.port}`)).status()).toBe(409);
  // Deleting an unknown/foreign handle is deliberately idempotent. Neither
  // request may destroy the original session's still-usable preparation.
  expect((await guest.delete(`/api/ssh/local-key/${id}`)).ok()).toBe(true);
  expect((await otherLogin.delete(`/api/ssh/local-key/${id}`)).ok()).toBe(true);
  expect((await launchKey(id)).status()).toBe(201);
  expect((await launchKey(id)).status()).toBe(409);
  for (const context of [guest, otherLogin])
    expect((await context.post(`/api/ssh/local-key/${id}/exchange`, { data: {} })).status()).toBe(409);
  let request: { seq: number; payload: string } | null = null;
  await expect
    .poll(async () => {
      const response = await admin.post(`/api/ssh/local-key/${id}/exchange`, { data: {} });
      expect(response.status()).toBe(200);
      request = (await response.json()).request;
      return request !== null;
    })
    .toBe(true);
  expect(request).toMatchObject({ seq: 0 });
  // A structurally valid agent failure at the wrong sequence must close the
  // bridge, rather than being delivered to a different outstanding request.
  const stale = await admin.post(`/api/ssh/local-key/${id}/exchange`, {
    data: { reply: { seq: 7, payload: "BQ==" } },
  });
  expect(stale.status()).toBe(409);
  expect((await admin.post(`/api/ssh/local-key/${id}/exchange`, { data: {} })).status()).toBe(409);
});

test("concurrent local-key launches consume one preparation only once", async () => {
  const id = await prepareKey();
  const replies = await Promise.all([launchKey(id), launchKey(id)]);
  expect(replies.map((reply) => reply.status()).sort()).toEqual([201, 409]);
  expect(panes).toHaveLength(1);
  expect((await admin.delete(`/api/ssh/local-key/${id}`)).ok()).toBe(true);
  expect((await admin.post(`/api/ssh/local-key/${id}/exchange`, { data: {} })).status()).toBe(409);
});
