import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NODE_PROTOCOL_VERSION,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_RESULT_VERSION_MISMATCH,
  NODE_SIGNED_UPDATES_PROTOCOL_VERSION,
  type NodeRuntimeReport,
  parseReleaseManifest,
} from "@internal/subshell-protocol";
import type { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  attachConnection,
  getHeld,
  getLive,
  holdConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { failConnPendings, resolveResult } from "@/services/nodes/node-rpc.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { resetUpdateTokensForTests } from "@/services/nodes/update-tokens.js";
import { releaseSeams, resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `POST /api/nodes/:id/update` (spec 2026-09-15 §5.3).
 *
 * The cases fall in two groups, and the split matters. The refusals BEFORE the
 * release lookup are gates on who and what: cookie-only, `local`, the
 * configure grant, and whether anything is connected at all. Those run against
 * a plane with no release source, because none of them should need one — a
 * gate that reached the network to say "you may not" would be a gate that
 * fails differently when the network does.
 *
 * The rest drive the command end to end against a FAKE RELEASE SOURCE served
 * by `Bun.serve`, so the release index, the signed manifest and the digest
 * are read exactly as they are in production. The one thing that stands in is
 * the minisign crypto itself — pinned once, against real `tauri signer`
 * fixtures, in the protocol package — via `releaseSeams.verifyManifest`.
 */

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
const nodeShares = new NodeSharesRepository(db);

/** A healthy systemd agent's report — pane-safe and supervised. */
const runtime: NodeRuntimeReport = {
  startedAt: "2026-09-15T00:00:00.000Z",
  supervised: true,
  service: {
    manager: "systemd",
    installed: true,
    definitionPath: "/x/subshell.service",
    state: "running",
    pid: 1,
    enabled: true,
    linger: true,
    paneSafety: "keeps",
  },
  configPath: "/c/config.json",
  agentLogPath: "/c/logs/agent.log",
  logPath: null,
  logHint: null,
  tmuxPath: "/usr/bin/tmux",
  binaryPath: "/b/subshell",
  logging: { debug: false, source: "default" as const },
};

/** The version the fake release publishes, chosen above any real one. */
const RELEASE_VERSION = "9.9.9";
const RELEASE_TAG = `cli-node-v${RELEASE_VERSION}`;

/**
 * The digest the fake manifest's `assets` map names for linux-x64. A `let`
 * rather than a constant so the disk-artifact-matches case can be built: no
 * real bytes hash to a fixed digest, so the test flips the manifest to name
 * the fixture's own hash and resets the release cache to re-read it.
 */
let manifestDigest = "a".repeat(64);

/**
 * The disk artifact the stale-file tests publish, and its sha — a real,
 * non-empty file whose hash cannot equal the manifest digest above (it is
 * fixed text, and the digest is 64 hex digits of someone else's bytes).
 */
const DISK_FIXTURE = Buffer.from("stale-published-node-binary\n");
const DISK_FIXTURE_SHA = createHash("sha256").update(DISK_FIXTURE).digest("hex");
/** Where {@link DISK_FIXTURE} is published, per the download routes' own name. */
const DISK_FIXTURE_PATH = join(NODE_ARTIFACTS_DIR, "subshell-node-cli-linux-x64");

/** Publish {@link DISK_FIXTURE} as this instance's linux-x64 node binary. */
function publishDiskFixture(): void {
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  writeFileSync(DISK_FIXTURE_PATH, DISK_FIXTURE);
}

/** Unpublish it — the file the download routes would otherwise keep serving. */
function unpublishDiskFixture(): void {
  try {
    unlinkSync(DISK_FIXTURE_PATH);
  } catch {
    /* already absent */
  }
}

/** The armor the fake verifier accepts; the fake release serves exactly this at `/sig`. */
const TEST_ARMOR = "TEST-ARMOR";
/** Restore point for the seam `beforeAll` swaps in — one process shares the module. */
const realVerify = { ...releaseSeams };

/**
 * The same fake verifier `releases.test.ts` installs: accepts the TEST-ARMOR
 * pair only, and still enforces the payload binding (component + version), so
 * a test that swapped a manifest body without its version would see the
 * refusal rather than a green wire.
 */
const acceptSigned: typeof verifyReleaseManifest = async (bytes, sig, _pub, expected) => {
  const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
  if (parsed === null) return { ok: false, reason: "test: the bytes are not a manifest" };
  if (sig.trim() !== TEST_ARMOR) return { ok: false, reason: "test: signature refused" };
  if (parsed.component !== expected.component || parsed.version !== expected.version) {
    return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
  }
  return { ok: true, manifest: parsed };
};

describe("POST /api/nodes/:id/update", () => {
  const pw = "node-update-1";
  const emails = {
    alice: `nu-alice-${crypto.randomUUID()}@subshell.local`,
    carol: `nu-carol-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId: string;
  let carolId: string;
  let aliceCookie = "";
  let carolCookie = "";
  const createdNodeIds: string[] = [];
  let release: ReturnType<typeof Bun.serve> | undefined;

  /** An offline agent node owned by alice, reporting a linux-x64 platform. */
  async function mkNode(): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nu-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    await nodes.applyReady(id, {
      agentVersion: "0.8.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    await nodes.setStatus(id, "offline");
    createdNodeIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    aliceId = await users.createUser({
      email: emails.alice,
      name: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    carolId = await users.createUser({
      email: emails.carol,
      name: emails.carol,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    aliceCookie = await signIn(emails.alice, pw);
    carolCookie = await signIn(emails.carol, pw);
    await ensureLocalNode(db);

    // The fake release source. It answers the LIST endpoint the real service
    // reads, a SIGNED manifest declaring THIS server's protocol, and a
    // sidecar — the reads `compatibleNodeRelease` + `fetchDigest` make, with
    // the digest the command carries coming from the manifest's `assets` map
    // (spec 2026-09-17: never the sidecar) rather than a guessed payload.
    release = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/releases") {
          const base = `http://127.0.0.1:${release?.port}`;
          return Response.json([
            {
              tag_name: RELEASE_TAG,
              draft: false,
              published_at: "2026-09-15T00:00:00Z",
              assets: [
                { name: "release-manifest.json", browser_download_url: `${base}/manifest` },
                { name: "release-manifest.json.sig", browser_download_url: `${base}/sig` },
                { name: "subshell-node-cli-linux-x64", browser_download_url: `${base}/bin` },
                { name: "subshell-node-cli-linux-x64.sha256", browser_download_url: `${base}/sha` },
              ],
            },
          ]);
        }
        if (url.pathname === "/manifest") {
          return Response.json({
            component: "cli-node",
            version: RELEASE_VERSION,
            nodeProtocol: NODE_PROTOCOL_VERSION,
            minNodeVersion: "0.9.0",
            commit: "deadbeef",
            assets: { "subshell-node-cli-linux-x64": manifestDigest },
          });
        }
        if (url.pathname === "/sig") return new Response(TEST_ARMOR);
        if (url.pathname === "/sha") return new Response(`${manifestDigest}\n`);
        return new Response("no", { status: 404 });
      },
    });
    // The crypto stands in here exactly as `releases.test.ts` does: real
    // minisign verification is pinned ONCE in the protocol package against
    // `tauri signer` fixtures, and this suite's subject is what the ROUTE
    // does with a manifest that verified.
    releaseSeams.verifyManifest = acceptSigned;
  });

  afterAll(async () => {
    Object.assign(releaseSeams, realVerify);
    resetNodeRegistryForTests();
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
    release?.stop(true);
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  afterEach(() => {
    resetNodeRegistryForTests();
    resetUpdateTokensForTests();
    unpublishDiskFixture();
  });

  /** Point the release service at the fake source and drop its memo. */
  function useFakeRelease(): void {
    setReleaseUrlForTests(`http://127.0.0.1:${release?.port}/releases`);
    resetReleaseCacheForTests();
  }

  /** Point it at nothing — the air-gapped configuration. */
  function useNoRelease(): void {
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
  }

  async function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  function fakeSocket(): NodeSocket & { sent: string[]; closed: number[] } {
    return {
      sent: [],
      closed: [],
      send(data: string) {
        this.sent.push(data);
        return data.length;
      },
      close(code?: number) {
        this.closed.push(code ?? 1000);
      },
    };
  }

  async function waitFor(cond: () => boolean, what: string, budgetMs = 3000): Promise<void> {
    for (let waited = 0; ; waited += 5) {
      if (cond()) return;
      if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Attach a live connection reporting `facts`. */
  function goOnline(nodeId: string, facts: NodeRuntimeReport | null = runtime): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    conn.agent = {
      dataDir: "/d",
      capabilities: [],
      hostname: "h",
      agentVersion: "0.8.0",
      ...(facts ? { runtime: facts } : {}),
    };
    return sock;
  }

  /** Attach a socket and HOLD it, as the ws handler does for a refused agent. */
  function goHeld(nodeId: string, protocolVersion: number = NODE_PROTOCOL_VERSION): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    holdConnection(nodeId, conn, {
      reason: "below-floor",
      agentVersion: "0.8.0",
      protocolVersion,
      os: "linux",
      arch: "x64",
      onIdle: () => undefined,
    });
    return sock;
  }

  /**
   * Fire the update and answer its one command with what the agent would send.
   *
   * It asserts the frame the plane put on the wire as it goes — the version,
   * the digest, and that the url carries a token — because those are the
   * fields the agent acts on and a route test that only checked the status
   * code would pass with any of them wrong.
   */
  async function updateWithAnswer(
    nodeId: string,
    cookie: string,
    body: unknown,
    answer: { ok: true } | { ok: false; error: string },
    conn: "live" | "held" = "live",
    facts: NodeRuntimeReport | null = runtime,
  ): Promise<{ res: Response; cmd: Record<string, unknown> }> {
    const sock = conn === "held" ? goHeld(nodeId) : goOnline(nodeId, facts);
    const record = conn === "held" ? getHeld(nodeId)?.conn : getLive(nodeId);
    if (!record) throw new Error("no connection record");
    const resP = req("POST", `/api/nodes/${nodeId}/update`, { cookie, body });
    await waitFor(() => sock.sent.length > 0, "update command on the wire");
    const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
    const claim = JSON.parse(Buffer.from((frame.jws.split(".")[1] ?? "") as string, "base64url").toString()) as {
      jti: string;
      aud: string;
      cmd: Record<string, unknown>;
    };
    expect(claim.aud).toBe(`node:${nodeId}`);
    const ev = answer.ok
      ? ({ type: "result", ref: claim.jti, ok: true } as const)
      : ({ type: "result", ref: claim.jti, ok: false, error: answer.error } as const);
    expect(resolveResult(record, ev)).toBe(true);
    return { res: await resP, cmd: claim.cmd };
  }

  /** The `code` of an error response. */
  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { code: string }).code;
  }

  // ── gates, none of which should need a release source ───────────────────

  it("401 anonymous, 404 unknown node", async () => {
    useNoRelease();
    const id = await mkNode();
    expect((await req("POST", `/api/nodes/${id}/update`, { body: {} })).status).toBe(401);
    const missing = await req("POST", `/api/nodes/${crypto.randomUUID()}/update`, { cookie: aliceCookie, body: {} });
    expect(missing.status).toBe(404);
  });

  it("local → 400, BEFORE the permission check", async () => {
    // A statement about the ROUTE rather than about the caller: the
    // control-plane host updates with the server, and a 403 would send
    // someone looking for an owner to ask.
    useNoRelease();
    const res = await req("POST", "/api/nodes/local/update", { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("BAD_REQUEST");
  });

  it("a view grantee is refused; an edit grantee is not", async () => {
    // The same gate `service restart` carries, because that is what this is.
    useNoRelease();
    const id = await mkNode();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("POST", `/api/nodes/${id}/update`, { cookie: carolCookie, body: {} })).status).toBe(403);

    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "edit" }], aliceId);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: carolCookie, body: {} });
    // Past the gate, refused for being disconnected — which is the next check.
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  it("neither live nor held → 409 NODE_OFFLINE", async () => {
    useNoRelease();
    const id = await mkNode();
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  // ── the signed-updates protocol gate (spec 2026-09-17 §6) ───────────────
  //
  // It runs BEFORE the release lookup and the token mint, from the held
  // record's number when there is one: a pre-12 agent parses the `update`
  // command but IGNORES `manifest`/`manifestSig`, so sending it the signed
  // release would silently install on the old trust rule — the exact
  // downgrade this whole change closes. A refusal must therefore arrive even
  // when the release side is perfectly fine, which is why these use the fake
  // release rather than the air-gapped one.

  it("refuses an agent on an older protocol, naming both numbers", async () => {
    useFakeRelease();
    const id = await mkNode();
    await nodes.applyReady(id, {
      agentVersion: "0.10.0",
      protocolVersion: NODE_PROTOCOL_VERSION - 1,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_AGENT_TOO_OLD");
    expect(err.message).toContain("predates signed updates");
    expect(err.message).toContain(`protocol ${NODE_PROTOCOL_VERSION - 1}`);
    expect(err.message).toContain(`need ${NODE_SIGNED_UPDATES_PROTOCOL_VERSION}`);
  });

  it("reads the number off the HELD socket when the row is behind it", async () => {
    // The held record is what the refused agent reported on the socket being
    // rescued — the row can hold an older `ready`'s number, and the fresher
    // answer is the honest one. Here it says "not capable", so that decides.
    useFakeRelease();
    const id = await mkNode();
    const sock = goHeld(id, NODE_PROTOCOL_VERSION - 1);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_AGENT_TOO_OLD");
    expect(sock.sent).toEqual([]);
  });

  it("refuses a never-ready node too — unknown capability is refused, not assumed", async () => {
    useFakeRelease();
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nu-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_AGENT_TOO_OLD");
    // No number in the sentence when nobody reported one.
    expect(err.message).toContain("predates signed updates");
    expect(err.message).not.toMatch(/protocol \d/);
  });

  it("no release source → 409 NODE_UPDATE_UNAVAILABLE naming the reason", async () => {
    useNoRelease();
    const id = await mkNode();
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_UPDATE_UNAVAILABLE");
  });

  it("a platform with no published artifact → 409 NODE_UPDATE_UNAVAILABLE", async () => {
    useFakeRelease();
    const id = await mkNode();
    // An Intel Mac: a real platform this project publishes nothing for.
    await nodes.applyReady(id, {
      agentVersion: "0.8.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "darwin",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_UPDATE_UNAVAILABLE");
    expect(err.message).toContain("darwin/x64");
  });

  // ── nothing-to-do refusals, before any artifact work ──────────────────────
  //
  // A node already on the offered release would re-download and reinstall the
  // same ~70 MB binary; one AHEAD of it would silently downgrade. Both answers
  // must arrive BEFORE the artifact/digest work, and nothing may go on the
  // wire. A node that never reported a version falls through: an update may be
  // exactly what fixes the ignorance.

  it("409 NODE_UP_TO_DATE when the node already runs the offered release", async () => {
    useFakeRelease();
    const id = await mkNode();
    await nodes.applyReady(id, {
      agentVersion: RELEASE_VERSION,
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    const sock = goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_UP_TO_DATE");
    expect(err.message).toContain(RELEASE_VERSION);
    expect(sock.sent).toEqual([]);
  });

  it("409 UPDATE_DOWNGRADE when the node reports newer than anything this server can offer", async () => {
    useFakeRelease();
    const id = await mkNode();
    await nodes.applyReady(id, {
      agentVersion: "99.0.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    const sock = goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("UPDATE_DOWNGRADE");
    expect(err.message).toContain("99.0.0");
    expect(err.message).toContain(RELEASE_VERSION);
    expect(sock.sent).toEqual([]);
  });

  // ── the artifact on disk is checked against the release it offers ────────
  //
  // The download route serves DISK-FIRST, but `fetchDigest` reads the signed
  // manifest — so a stale file in NODE_ARTIFACTS_DIR (an operator-published
  // artifact is never superseded) made the plane order an update whose digest
  // the bytes it serves could never match. Proven live: the node downloaded
  // the old binary, refused it on its own digest check, and the operator paid
  // ~70 MB to learn the offer was incoherent. These pin the plane's refusal
  // of that offer BEFORE anything reaches the node.

  it("a disk artifact from another release → 409 NODE_UPDATE_UNAVAILABLE, nothing sent", async () => {
    useFakeRelease();
    publishDiskFixture(); // its sha cannot equal the manifest's fixed digest
    const id = await mkNode();
    const sock = goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_UPDATE_UNAVAILABLE");
    expect(err.message).toContain("linux-x64");
    // The remedy a BROWSER operator can act on is the delete; the repo's
    // publish script is documentation, never a build internal in the copy.
    expect(err.message).toContain("node-artifacts");
    expect(err.message).toContain("verified release");
    // The offer was refused before the command went out — the node downloads
    // nothing, mints nothing, and learns nothing of the incoherence.
    expect(sock.sent).toEqual([]);
    const rows = await new AuditRepository(db).listLatest(20);
    expect(rows.find((r) => r.action === "node.update" && r.targetId === id)).toBeUndefined();
  });

  it("a disk artifact MATCHING the offered digest is served, and the update proceeds", async () => {
    useFakeRelease();
    publishDiskFixture();
    // The manifest must name what is actually on disk: flip it to the
    // fixture's own hash, then re-read the (memoized) manifest.
    manifestDigest = DISK_FIXTURE_SHA;
    resetReleaseCacheForTests();
    const id = await mkNode();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(202);
    expect(cmd.sha256).toBe(DISK_FIXTURE_SHA);
    // Restore the shared manifest before any later test reads it.
    manifestDigest = "a".repeat(64);
    resetReleaseCacheForTests();
  });

  it("no disk artifact → the lazy fetch will serve the release, and the update proceeds", async () => {
    useFakeRelease();
    unpublishDiskFixture(); // this file's own leftovers; the 202s above already assume absence
    const id = await mkNode();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(202);
    expect(cmd.sha256).toBe("a".repeat(64));
  });

  // ── the command, end to end ─────────────────────────────────────────────

  it("202 on success, with the version, a tokenless url, and an audit row", async () => {
    useFakeRelease();
    const id = await mkNode();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: true; from: string; to: string; url: string };
    expect(body).toMatchObject({ ok: true, from: "0.8.0", to: RELEASE_VERSION });
    // The url the PAGE sees carries no credential — it is echoed so a loopback
    // APP_BASE_URL can be warned about, not so anyone can re-use the download.
    expect(body.url).not.toContain("update_token");
    expect(body.url).toContain("/api/downloads/node/linux-x64");

    // The command the AGENT sees is the frozen shape, with the token baked in.
    expect(cmd.type).toBe("update");
    expect(cmd.version).toBe(RELEASE_VERSION);
    // The digest now comes from the manifest's own assets map (D2), and the
    // verified manifest + signature ride with the order (spec 2026-09-17 §6)
    // so the node re-verifies WHAT will run against its compiled-in pubkey
    // rather than trusting this server's bytes.
    expect(cmd.sha256).toBe("a".repeat(64));
    expect(JSON.parse(Buffer.from(String(cmd.manifest), "base64").toString("utf8"))).toMatchObject({
      component: "cli-node",
      version: RELEASE_VERSION,
    });
    expect(cmd.manifestSig).toBe(TEST_ARMOR);
    expect(String(cmd.url)).toMatch(/[?&]update_token=nut_/);
    // No `force` unless asked: an absent flag must not arrive as `false`,
    // which the agent would read the same but which widens the frozen shape.
    expect(cmd).not.toHaveProperty("force");

    const rows = await new AuditRepository(db).listLatest(20);
    const row = rows.find((r) => r.action === "node.update" && r.targetId === id);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.metadataJson ?? "{}")).toEqual({ from: "0.8.0", to: RELEASE_VERSION, forced: false });
  });

  it("reaches a HELD node — the case this route exists for", async () => {
    // A node the plane refuses for its version is offline for every other
    // purpose. Being able to update it from a browser is the whole point of
    // holding the socket instead of closing it.
    useFakeRelease();
    const id = await mkNode();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true }, "held");
    expect(res.status).toBe(202);
    expect(cmd.type).toBe("update");
  });

  it("passes force through, and the audit row records it", async () => {
    useFakeRelease();
    const id = await mkNode();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, { force: true }, { ok: true });
    expect(res.status).toBe(202);
    expect(cmd.force).toBe(true);
    const rows = await new AuditRepository(db).listLatest(20);
    const row = rows.find((r) => r.action === "node.update" && r.targetId === id);
    expect(JSON.parse(row?.metadataJson ?? "{}").forced).toBe(true);
  });

  /**
   * A TIMEOUT is the one failure that may not be one, and it leaves a row of
   * its own.
   *
   * Every other refusal here is the agent SAYING it did nothing. A timeout is
   * the agent saying nothing at all — and this command's deadline contains a
   * ~70 MB download, so a node on a slow link installs the binary, restarts,
   * and comes back on the new version while this request answers 409. Without
   * the row, a real binary replacement would have no audit trail and an error
   * on the admin's screen; with it, "why is that machine on a version nothing
   * recorded" has an answer.
   *
   * Its own action name, because `node.update` and "nobody knows" are two
   * different claims and a reader must not have to guess which one a row is.
   */
  it("records node.update.unknown when the agent never answers", async () => {
    useFakeRelease();
    const id = await mkNode();
    const sock = goOnline(id);
    const record = getLive(id);
    if (!record) throw new Error("no connection record");
    const resP = req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    await waitFor(() => sock.sent.length > 0, "update command on the wire");
    // The deadline firing, without waiting five real minutes for it.
    expect(failConnPendings(record, "timeout", "the node did not answer in time")).toBe(1);
    const res = await resP;
    expect(res.status).toBe(409);

    const rows = await new AuditRepository(db).listLatest(20);
    expect(rows.find((r) => r.action === "node.update" && r.targetId === id)).toBeUndefined();
    const unknown = rows.find((r) => r.action === "node.update.unknown" && r.targetId === id);
    expect(unknown).toBeDefined();
    expect(JSON.parse(unknown?.metadataJson ?? "{}")).toEqual({
      from: "0.8.0",
      to: RELEASE_VERSION,
      forced: false,
    });
    // And no token in it, like every other row this route writes.
    expect(unknown?.metadataJson ?? "").not.toContain("nut_");
  });

  it("writes NO unknown row for a refusal the agent actually spoke", async () => {
    // The distinction the extra action name exists to keep: an agent that said
    // "not supervised" did nothing, and a row claiming its state is unknown
    // would be worse than no row at all.
    useFakeRelease();
    const id = await mkNode();
    const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(res.status).toBe(409);
    const rows = await new AuditRepository(db).listLatest(20);
    expect(rows.find((r) => r.action === "node.update.unknown" && r.targetId === id)).toBeUndefined();
  });

  // ── every refusal the AGENT raises, mapped by `detail` equality ──────────

  it("maps each of the agent's own refusals onto its own code", async () => {
    useFakeRelease();
    const cases: { error: string; code: string }[] = [
      { error: NODE_RESULT_NOT_SUPERVISED, code: "NODE_NOT_SUPERVISED" },
      { error: NODE_RESULT_KILLS_PANES, code: "NODE_RESTART_KILLS_PANES" },
      { error: NODE_RESULT_NOT_COMPILED, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_DOWNLOAD_FAILED, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_DIGEST_MISMATCH, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_VERSION_MISMATCH, code: "NODE_UPDATE_FAILED" },
      // Anything the route does not recognize is a failure rather than a guess.
      { error: "the disk is full", code: "NODE_UPDATE_FAILED" },
    ];
    for (const c of cases) {
      const id = await mkNode();
      const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: c.error });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe(c.code);
      resetNodeRegistryForTests();
    }
  });

  it("an agent too old to know the command answers `unsupported` → NODE_AGENT_TOO_OLD, naming the CLI verb", async () => {
    // The ordinary answer from exactly the machines this feature is for: an
    // agent below the floor has no `update` executor at all, and the only
    // remedy left is somebody typing at that keyboard.
    useFakeRelease();
    const id = await mkNode();
    const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: "unsupported" }, "held");
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_AGENT_TOO_OLD");
    expect(err.message).toContain("subshell update");
  });

  it("says whether panes WOULD die or nobody could tell, in the wording and never the code", async () => {
    // The agent sends one string for `kills` and `unknown`, because its
    // destructive verbs fail closed on a definition they could not read. Only
    // the plane can tell the two apart, and telling someone their panes will
    // die when nobody could tell is how warnings get ignored.
    useFakeRelease();
    const unknown: NodeRuntimeReport = { ...runtime, service: { ...runtime.service, paneSafety: "unknown" } };
    const id = await mkNode();
    const { res } = await updateWithAnswer(
      id,
      aliceCookie,
      {},
      { ok: false, error: NODE_RESULT_KILLS_PANES },
      "live",
      unknown,
    );
    expect(await codeOf(res)).toBe("NODE_RESTART_KILLS_PANES");
    resetNodeRegistryForTests();

    const id2 = await mkNode();
    const second = await updateWithAnswer(id2, aliceCookie, {}, { ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(((await second.res.json()) as { message: string }).message).toContain("would close every subshell");
  });
});
