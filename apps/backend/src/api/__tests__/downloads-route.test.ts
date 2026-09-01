import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { downloadsRoutes } from "@/api/downloads.route.js";
import { installScriptRoute } from "@/api/install-script.js";
import { APP_BASE_URL, NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `GET /api/downloads/node/:target[.sha256]` + `GET /install.sh` (spec
 * 2026-08-31 §8). The gate is cookie session OR a valid, unconsumed setup key;
 * targets are a closed enum validated before any path construction; sha reads
 * an on-disk sidecar when present and computes (and caches by mtime) otherwise.
 * Artifacts come from the real `NODE_ARTIFACTS_DIR` — under IS_TEST that is
 * inside this process's temp data dir, so fixtures are written straight there.
 */
describe("/api/downloads + /install.sh", () => {
  const email = `dl-${crypto.randomUUID()}@mote.local`;
  const pw = "downloads-1";
  const TARGET = "linux-x64";
  const fixturePath = join(NODE_ARTIFACTS_DIR, `mote-agent-${TARGET}`);
  const sidecarPath = `${fixturePath}.sha256`;
  const FIXTURE = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 0xde, 0xad, 0xbe, 0xef]);
  let expectedSha = "";
  let cookie = "";
  let userId = "";
  const repo = new NodeSetupKeysRepository(db);
  const createdKeyIds: string[] = [];

  /** GET a downloads path with optional cookie / setup-key credentials. */
  async function dl(path: string, opts: { cookie?: string; key?: string } = {}): Promise<Response> {
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    const q = opts.key ? `?setup_key=${encodeURIComponent(opts.key)}` : "";
    return downloadsRoutes.fetch(new Request(`http://localhost:3080/api/downloads${path}${q}`, { headers }));
  }

  async function mkKey(ttlMs?: number): Promise<string> {
    const { row, plaintext } = await repo.create("dl-test", userId, ttlMs);
    createdKeyIds.push(row.id);
    return plaintext;
  }

  beforeAll(async () => {
    await setupAuthTables();
    mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
    writeFileSync(fixturePath, FIXTURE);
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    const digest = await crypto.subtle.digest("SHA-256", FIXTURE.slice().buffer);
    expectedSha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });

  afterAll(async () => {
    rmSync(fixturePath, { force: true });
    rmSync(sidecarPath, { force: true });
    await deleteUserByEmailOrId(email);
    for (const id of createdKeyIds) await repo.deleteById(id, userId);
  });

  // ── target validation (before any filesystem path construction) ──────────

  it("unknown target → 404, even authenticated", async () => {
    for (const res of [await dl("/node/windows-x64"), await dl("/node/windows-x64", { cookie })]) {
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; statusCode: number };
      expect(body.code).toBe("NOT_FOUND_ERROR");
      expect(body.statusCode).toBe(404);
    }
  });

  it("path traversal in :target → 404 (enum rejects before path build)", async () => {
    for (const p of ["/node/..%2F..%2Fetc%2Fpasswd", "/node/....256", "/node/linux-x64.txt"]) {
      const res = await dl(p, { cookie });
      expect(res.status).toBe(404);
    }
  });

  it("unknown .sha256 target → 404", async () => {
    expect((await dl("/node/windows-x64.sha256", { cookie })).status).toBe(404);
  });

  // ── the cookie-or-setup-key gate ──────────────────────────────────────────

  it("no cookie and no setup key → 401 ApiErrorResponse JSON on binary and sha", async () => {
    for (const path of [`/node/${TARGET}`, `/node/${TARGET}.sha256`]) {
      const res = await dl(path);
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { code: string; errId: string; statusCode: number };
      expect(typeof body.errId).toBe("string");
      expect(body.statusCode).toBe(401);
    }
  });

  it("bogus setup key → 401; expired key → 401; consumed key → 401", async () => {
    expect((await dl(`/node/${TARGET}`, { key: "nsk_not_a_real_key_at_all" })).status).toBe(401);
    expect((await dl(`/node/${TARGET}`, { key: await mkKey(-60_000) })).status).toBe(401);
    const spent = await mkKey();
    await repo.consume(spent, "node-x");
    expect((await dl(`/node/${TARGET}`, { key: spent })).status).toBe(401);
  });

  it("a peek via setup key does NOT consume it (enroll must still be able to redeem)", async () => {
    const key = await mkKey();
    expect((await dl(`/node/${TARGET}`, { key })).status).toBe(200);
    expect((await dl(`/node/${TARGET}`, { key })).status).toBe(200);
    expect(await repo.peekValid(key)).toBe(true);
  });

  // ── the binary route ──────────────────────────────────────────────────────

  it("valid setup key → 200 with the fixture bytes", async () => {
    const key = await mkKey();
    const res = await dl(`/node/${TARGET}`, { key });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FIXTURE);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain(`mote-agent-${TARGET}`);
  });

  it("cookie session → 200 (no setup key needed)", async () => {
    const res = await dl(`/node/${TARGET}`, { cookie });
    expect(res.status).toBe(200);
  });

  it("known target but binary not on disk → 404 ApiErrorResponse", async () => {
    const res = await dl("/node/darwin-arm64", { cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
  });

  // ── the .sha256 routes ────────────────────────────────────────────────────

  it(".sha256 → 200 with the 64-hex digest of the binary", async () => {
    const res = await dl(`/node/${TARGET}.sha256`, { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(text.trim()).toBe(expectedSha);
  });

  it(".sha256 prefers an on-disk sidecar and notices a swapped binary (mtime-keyed cache)", async () => {
    const fakeHex = "a".repeat(64);
    writeFileSync(sidecarPath, `${fakeHex}  mote-agent-${TARGET}\n`);
    try {
      const side = await dl(`/node/${TARGET}.sha256`, { cookie });
      expect(side.status).toBe(200);
      expect((await side.text()).trim()).toBe(fakeHex);
    } finally {
      rmSync(sidecarPath, { force: true });
    }
    // Swap the bytes behind the same name → the computed sha must follow.
    writeFileSync(fixturePath, new Uint8Array([...FIXTURE, 0x99]));
    utimesSync(fixturePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const after = await dl(`/node/${TARGET}.sha256`, { cookie });
    expect((await after.text()).trim()).not.toBe(fakeHex);
    writeFileSync(fixturePath, FIXTURE); // restore for any later assertion
    utimesSync(fixturePath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
  });

  it(".sha256 for a known target with no binary on disk → 404", async () => {
    expect((await dl("/node/darwin-x64.sha256", { cookie })).status).toBe(404);
  });

  // ── /install.sh ───────────────────────────────────────────────────────────

  async function install(key?: string): Promise<Response> {
    const q = key ? `?setup_key=${encodeURIComponent(key)}` : "";
    return installScriptRoute.fetch(new Request(`http://localhost:3080/install.sh${q}`));
  }

  it("install.sh with no key → text/plain usage script that exits 2 (never 401 JSON)", async () => {
    const res = await install();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("set -euo pipefail");
    expect(body).toContain("exit 2");
    expect(body).toContain("usage");
    expect(body).not.toContain("api/downloads"); // no download pipeline is rendered
  });

  it("install.sh with an invalid key → the same usage script, key not echoed back", async () => {
    const bogus = "nsk_definitely_not_valid_000000";
    const res = await install(bogus);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("exit 2");
    expect(body).not.toContain(bogus);
  });

  it("install.sh with a valid key → full pipeline; key appears ONLY in the KEY assignment", async () => {
    const key = await mkKey();
    const res = await install(key);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("set -euo pipefail");
    expect(body).toContain(`SERVER="${APP_BASE_URL}"`); // same source enroll's wsUrl derives from
    expect(body).toContain(`KEY="${key}"`);
    expect(body.split(key).length - 1).toBe(1); // exactly one literal occurrence
    // uname detection covers all four targets and fails loudly otherwise
    for (const m of ["Linux/x86_64", "Linux/aarch64", "Darwin/x86_64", "Darwin/arm64"]) {
      expect(body).toContain(m);
    }
    expect(body).toContain("linux-x64");
    expect(body).toContain("darwin-arm64");
    // download, verify (both spellings), chmod, enroll, next step
    expect(body).toContain("$SERVER/api/downloads/node/$TARGET?setup_key=$KEY");
    expect(body).toContain("$TARGET.sha256");
    expect(body).toContain("sha256sum -c");
    expect(body).toContain("shasum -a 256 -c");
    expect(body).toContain("chmod +x mote-agent");
    expect(body).toContain('./mote-agent enroll --server "$SERVER" --key "$KEY"');
    expect(body).toContain("./mote-agent run");
    expect(body).not.toContain("exit 2");
  });
});
