import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
} from "@internal/subshell-protocol";
import type { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { downloadsRoutes } from "@/api/downloads.route.js";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { resetShelfProbeForTests, shelfVersionFacts } from "@/lib/node-artifact-serve.js";
import { resetAnnouncedShaCacheForTests, resetDiskShaCacheForTests } from "@/lib/node-artifacts.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { releaseSeams, resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(downloadsRoutes);

const TARGET = "linux-x64";
const BINARY = `subshell-node-cli-${TARGET}`;
const NEWBODY = "the release's bytes, ninety tonnes of agent";
const TEST_ARMOR = "test: minisign arm accepted";

/** A shelf copy that ANSWERS for itself: the node CLI's version line, as a script. */
const shelfScript = (version: string, protocol: number) =>
  `#!/bin/sh\necho "subshell ${version} (node protocol v${protocol})"\n`;

function hex(bytes: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(new TextEncoder().encode(bytes));
  return h.digest("hex");
}

const realVerify = { ...releaseSeams };
const acceptSigned: typeof verifyReleaseManifest = async (bytes, sig, _pub, expected) => {
  const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
  if (parsed === null) return { ok: false, reason: "test: not a manifest" };
  if (sig.trim() !== TEST_ARMOR) return { ok: false, reason: "test: signature refused" };
  if (parsed.component !== expected.component || parsed.version !== expected.version) {
    return { ok: false, reason: "test: payload mismatch" };
  }
  return { ok: true, manifest: parsed };
};

/**
 * The shelf reconciled against the release (spec 2026-10-09): every cell of
 * the rule, answered through the REAL routes so binary and `.sha256` are
 * proven to agree — an announced digest that skips an install past the
 * reconciliation the download would have applied is exactly the bug class.
 */
describe("/api/downloads/node — the shelf answers for itself", () => {
  const email = `shelf-${crypto.randomUUID()}@subshell.local`;
  const pw = "shelf-serve-1";
  let cookie = "";
  const binaryPath = join(NODE_ARTIFACTS_DIR, BINARY);
  const ledgerPath = join(NODE_ARTIFACTS_DIR, ".fetched.json");

  /** Flipped per test: what the fake release's SIGNED manifest claims. */
  let manifestProtocol = NODE_PROTOCOL_VERSION;
  let binHits = 0;
  /** Flipped per test: the index is fine, the BINARY is unreachable. */
  let failBin = false;
  let releaseBase = "";

  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    await setupAuthTables();
    mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${server.port}`;
        if (url.pathname === "/releases") {
          return Response.json([
            {
              tag_name: "cli-node-v9.9.9",
              draft: false,
              assets: [
                { name: BINARY, browser_download_url: `${base}/bin` },
                { name: `${BINARY}.sha256`, browser_download_url: `${base}/sha` },
                { name: RELEASE_MANIFEST_NAME, browser_download_url: `${base}/manifest` },
                { name: RELEASE_MANIFEST_SIG_NAME, browser_download_url: `${base}/sig` },
              ],
            },
          ]);
        }
        if (url.pathname === "/bin") {
          binHits += 1;
          if (failBin) return new Response("gone", { status: 500 });
          return new Response(NEWBODY);
        }
        if (url.pathname === "/sha") return new Response(`${hex(NEWBODY)}\n`);
        if (url.pathname === "/sig") return new Response(TEST_ARMOR);
        if (url.pathname === "/manifest") {
          return Response.json({
            component: "cli-node",
            version: "9.9.9",
            nodeProtocol: manifestProtocol,
            minNodeVersion: MIN_NODE_VERSION,
            commit: "0123456789abcdef0123456789abcdef01234567",
            assets: { [BINARY]: hex(NEWBODY) },
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    releaseBase = `http://127.0.0.1:${server.port}`;
    releaseSeams.verifyManifest = acceptSigned;
  });

  afterAll(async () => {
    Object.assign(releaseSeams, realVerify);
    server.stop(true);
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
    rmSync(binaryPath, { force: true });
    rmSync(`${binaryPath}.sha256`, { force: true });
    rmSync(ledgerPath, { force: true });
    await deleteUserByEmailOrId(email);
  });

  beforeEach(() => {
    // Every cache that could carry one cell's verdict into the next.
    resetReleaseCacheForTests();
    resetShelfProbeForTests();
    resetDiskShaCacheForTests();
    resetAnnouncedShaCacheForTests();
    rmSync(binaryPath, { force: true });
    rmSync(`${binaryPath}.sha256`, { force: true });
    rmSync(ledgerPath, { force: true });
    manifestProtocol = NODE_PROTOCOL_VERSION;
    binHits = 0;
    failBin = false;
    setReleaseUrlForTests(`${releaseBase}/releases`);
  });

  function plantShelf(contents: string): string {
    writeFileSync(binaryPath, contents);
    chmodSync(binaryPath, 0o755);
    return contents;
  }

  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`, { headers: { cookie: `better-auth.session_token=${cookie}` } }));

  it("a shelf BEHIND the release serves the release, and the digest route announces the SAME answer", async () => {
    const shelf = plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(NEWBODY);
    // Operator bytes, no ledger entry: streamed PAST, never overwritten.
    expect(readFileSync(binaryPath, "utf8")).toBe(shelf);

    const sha = await get(`/api/downloads/node/${TARGET}.sha256`);
    expect((await sha.text()).trim()).toBe(hex(NEWBODY));
  });

  it("a shelf NEWER than the release, speaking this protocol, stays operator truth", async () => {
    const shelf = plantShelf(shelfScript("10.0.0", NODE_PROTOCOL_VERSION));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(shelf);
    expect(binHits).toBe(0);
    const sha = await get(`/api/downloads/node/${TARGET}.sha256`);
    expect((await sha.text()).trim()).toBe(hex(shelf));
  });

  it("a shelf whose bytes ARE the release is the fast path: served without touching the source", async () => {
    plantShelf(NEWBODY);
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(NEWBODY);
    expect(binHits).toBe(0);
  });

  it("a shelf that CANNOT CONNECT is never served while a compatible release exists, even claiming a newer version", async () => {
    const shelf = plantShelf(shelfScript("99.0.0", NODE_PROTOCOL_VERSION - 1));
    const res = await get(`/api/downloads/node/${TARGET}`);
    // The disaresta cell, made unmissable: yesterday the wrong-protocol copy
    // won on "newer" and every fresh machine 4410-looped after a successful
    // install.
    expect(await res.text()).toBe(NEWBODY);
    expect(readFileSync(binaryPath, "utf8")).toBe(shelf); // still not operator-overwritten
  });

  it("no compatible release AND a wrong-protocol shelf: both routes refuse, naming the mismatch", async () => {
    manifestProtocol = NODE_PROTOCOL_VERSION - 1;
    plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION - 1));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.message).toContain("protocol");
    const sha = await get(`/api/downloads/node/${TARGET}.sha256`);
    expect(sha.status).toBe(404);
  });

  it("no compatible release but a shelf that CAN connect: the shelf serves (dev-loop and air-gap-adjacent cells)", async () => {
    manifestProtocol = NODE_PROTOCOL_VERSION - 1;
    const shelf = plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(shelf);
  });

  it("a shelf that answers NOTHING defers to the release when one exists", async () => {
    plantShelf("not an executable at all");
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(NEWBODY);
  });

  it("air-gapped: the shelf is the only source and always wins, behind or ahead", async () => {
    setReleaseUrlForTests(null);
    const behind = plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    expect(await (await get(`/api/downloads/node/${TARGET}`)).text()).toBe(behind);
    const sha = await get(`/api/downloads/node/${TARGET}.sha256`);
    expect((await sha.text()).trim()).toBe(hex(behind));
    resetShelfProbeForTests();
    const ahead = plantShelf(shelfScript("10.0.0", NODE_PROTOCOL_VERSION));
    expect(await (await get(`/api/downloads/node/${TARGET}`)).text()).toBe(ahead);
  });

  it("a sidecar lying about its own bytes loses shelf precedence: announcement and bytes agree on the RELEASE", async () => {
    // The shelf actually HOLDS the release bytes, but a stale hand-written
    // sidecar announces something older. Measuring the decision against the
    // announcement (not the raw bytes) is what keeps a machine's skip honest:
    // it can only skip to what it would have downloaded.
    plantShelf(NEWBODY);
    writeFileSync(`${binaryPath}.sha256`, `${"f".repeat(64)}\n`);
    const sha = await get(`/api/downloads/node/${TARGET}.sha256`);
    expect((await sha.text()).trim()).toBe(hex(NEWBODY));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(NEWBODY);
  });

  it("the release the decision chose cannot be fetched: 404, and the shelf is NOT served under a release announcement", async () => {
    plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    failBin = true;
    try {
      const res = await get(`/api/downloads/node/${TARGET}`);
      expect(res.status).toBe(404);
    } finally {
      failBin = false;
    }
  });

  it("bytes this INSTANCE fetched are cache the release may replace", async () => {
    const shelf = plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [TARGET]: { tag: "cli-node-v0.0.1", digest: hex(shelf), fetchedAt: "x" } }),
    );
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(await res.text()).toBe(NEWBODY);
    // Ours to replace: the fetch cached over the old bytes.
    expect(readFileSync(binaryPath, "utf8")).toBe(NEWBODY);
  });

  it("release unreachable with a connectable shelf: the older agent still installs (outdated beats refused)", async () => {
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    const shelf = plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(shelf);
  });

  it("release unreachable with a wrong-protocol shelf: still the 404, never the refusal-loop installer", async () => {
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    plantShelf(shelfScript("1.0.0", NODE_PROTOCOL_VERSION - 1));
    const res = await get(`/api/downloads/node/${TARGET}`);
    expect(res.status).toBe(404);
  });

  it("the probe parses the agent's own line and re-reads when the file's identity changes", async () => {
    plantShelf(shelfScript("2.3.4", 12));
    expect(await shelfVersionFacts(TARGET)).toEqual({ version: "2.3.4", protocol: 12 });
    // Different bytes AND different size: the cache key (path:mtime:size) moves.
    plantShelf(shelfScript("10.0.0", 13));
    expect(await shelfVersionFacts(TARGET)).toEqual({ version: "10.0.0", protocol: 13 });
  });
});
