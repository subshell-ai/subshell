import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { transferRoutes } from "@/api/transfers/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * POST /api/transfers - the GATE STACK of spec 2026-10-01 §5, end to end
 * through the real authGuard (cookie and bearer) and the real registry. The
 * relay itself is pinned by `services/__tests__/transfers.service.test.ts`;
 * what lives here is the ORDERING that matters: foreign rows 404 before any
 * other fact can leak, `local` refuses by name, maintenance outranks
 * offline (an operator can act on one and not the other), the freshly minted
 * token carries `transfers` while the gate itself is pinned in
 * `api/__tests__/transfers-perm.test.ts`, and the audit family records the
 * attempt and the outcome.
 */

// The route's refusals ride `throwApiError`, so the test composition needs
// the real error mapper, exactly as the server's does (restart.route.test.ts
// is the precedent for why a bare mount answers those 500).
const app = new Elysia().use(errorHandlerPlugin).use(transferRoutes);

const body = (from: { nodeId: string; path: string }, to: { nodeId: string; path: string }, sync?: boolean): string =>
  JSON.stringify(sync === undefined ? { from, to } : { from, to, sync });

let userId: string;
let otherUserId: string;
let session: string;
const email = `transfer-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `transfer2-${crypto.randomUUID()}@subshell.local`;
const pw = "transfer-pass-1";
const nodeIds: string[] = [];
const scripted: ScriptedNode[] = [];
const subshellIds: string[] = [];

async function makeNode(ownerId: string, kind: "agent" | "local" = "agent"): Promise<string> {
  const id = `n-${crypto.randomUUID().slice(0, 8)}`;
  nodeIds.push(id);
  await new NodesRepository(db).create({ id, ownerUserId: ownerId, name: id, kind });
  return id;
}

/** Script both endpoints of a minimal successful copy. */
function fakePair(from: string, to: string, archive: Uint8Array): void {
  scripted.push(
    attachScriptedNode(
      from,
      {
        archive_create: () => ({
          size: archive.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
        }),
        file_read: (cmd) =>
          cmd.type === "file_read"
            ? { bytes_b64: Buffer.from(archive).toString("base64"), next: archive.byteLength, size: archive.byteLength }
            : new Error("wrong"),
        remove_paths: () => undefined,
      },
      { dataDir: "/sd-src" },
    ),
    attachScriptedNode(
      to,
      {
        transfer_write: (cmd) =>
          cmd.type === "transfer_write"
            ? { path: cmd.path, received: Buffer.from(cmd.chunkB64, "base64").byteLength }
            : new Error("wrong"),
        archive_extract: () => ({ files: 1, bytes: archive.byteLength }),
        remove_paths: () => undefined,
      },
      { dataDir: "/sd-dst" },
    ),
  );
}

beforeAll(async () => {
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  session = await signIn(email, pw);
  otherUserId = await new UsersRepository(db).createUser({
    email: otherEmail,
    name: otherEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
});

afterAll(async () => {
  for (const s of scripted) s.detach();
  for (const id of subshellIds) await new SubshellsRepository(db).delete(id).catch(() => {});
  for (const id of nodeIds) await new NodesRepository(db).deleteById(id).catch(() => {});
  await deleteUserByEmailOrId(email);
  await deleteUserByEmailOrId(otherEmail);
});

describe("POST /api/transfers gates", () => {
  it("refuses an unauthenticated request outright", async () => {
    const res = await app.fetch(
      new Request("http://localhost:3080/api/transfers", {
        method: "POST",
        body: body({ nodeId: "x", path: "/a" }, { nodeId: "y", path: "/b" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404s a node the caller does not own BEFORE any other fact leaks", async () => {
    const foreign = await makeNode(otherUserId);
    const mine = await makeNode(userId);
    const res = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: foreign, path: "/a" }, { nodeId: mine, path: "/b" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
  });

  it("400s `local` endpoints by name, on either side", async () => {
    const localId = await makeNode(userId, "local");
    const mine = await makeNode(userId);
    const asFrom = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: localId, path: "/a" }, { nodeId: mine, path: "/b" }),
      }),
    );
    expect(asFrom.status).toBe(400);
    expect(((await asFrom.json()) as { message: string }).message).toContain("agent nodes");
    // Reversed pair: the `to` side names `local`, so the `from` must be a
    // live agent for the call to reach that gate at all (from gates first).
    fakePair(mine, localId, new Uint8Array(1));
    const asTo = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: mine, path: "/a" }, { nodeId: localId, path: "/b" }),
      }),
    );
    expect(asTo.status).toBe(400);
    expect(((await asTo.json()) as { message: string }).message).toContain("agent nodes");
  });

  it("409s maintenance ahead of offline, and offline for a dead socket", async () => {
    const maint = await makeNode(userId);
    await new NodesRepository(db).setMaintenance(maint, {
      on: true,
      changedAt: new Date().toISOString(),
      source: "plane",
    });
    const dead = await makeNode(userId);
    const maintRes = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: maint, path: "/a" }, { nodeId: dead, path: "/b" }),
      }),
    );
    expect(maintRes.status).toBe(409);
    expect(((await maintRes.json()) as { code: string }).code).toBe("NODE_IN_MAINTENANCE");
    const offline = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: dead, path: "/a" }, { nodeId: maint, path: "/b" }),
      }),
    );
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { code: string }).code).toBe("NODE_OFFLINE");
  });

  it("400s relative paths and same-directory endpoints", async () => {
    const a = await makeNode(userId);
    const b = await makeNode(userId);
    const rel = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: a, path: "relative/x" }, { nodeId: b, path: "/b" }),
      }),
    );
    expect(rel.status).toBe(400);
    expect(((await rel.json()) as { message: string }).message).toContain("absolute");
    // The same-endpoint check runs AFTER both nodes gate (it is a request
    // sanity check on live machines, not a discovery oracle), so `a` needs a
    // scripted socket for this call to reach it.
    scripted.push(attachScriptedNode(a, {}, { dataDir: "/sd-a" }));
    const same = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: a, path: "/x" }, { nodeId: a, path: "/x" }),
      }),
    );
    expect(same.status).toBe(400);
    expect(((await same.json()) as { message: string }).message).toContain("same directory");
  });

  it("copies for the owner over cookie, and audits the attempt and outcome", async () => {
    const from = await makeNode(userId);
    const to = await makeNode(userId);
    fakePair(from, to, new Uint8Array(64).fill(7));
    const res = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: from, path: "/src" }, { nodeId: to, path: "/dst" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sync: false, archiveBytes: 64, files: 1, bytes: 64, changed: 0 });
    const rows = await db
      .selectFrom("auditEvents")
      .select(["action", "metadataJson"])
      .where("actorUserId", "=", userId)
      .where("action", "in", ["transfer.create", "transfer.complete"])
      .orderBy("createdAt", "desc")
      .limit(2)
      .execute();
    expect(rows.map((r) => r.action).sort()).toEqual(["transfer.complete", "transfer.create"]);
    const complete = rows.find((r) => r.action === "transfer.complete");
    expect(JSON.parse(complete?.metadataJson ?? "{}")).toMatchObject({
      fromNodeId: from,
      toNodeId: to,
      outcome: "ok",
      files: 1,
    });
  });

  it("a freshly minted subshell token carries transfers and moves bytes", async () => {
    const from = await makeNode(userId);
    const to = await makeNode(userId);
    fakePair(from, to, new Uint8Array(8).fill(1));
    const subshellId = crypto.randomUUID();
    subshellIds.push(subshellId);
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "transfer-bearer",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(subshellId, userId);
    const res = await app.fetch(
      new Request("http://localhost:3080/api/transfers", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: body({ nodeId: from, path: "/src" }, { nodeId: to, path: "/dst" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sync: false, archiveBytes: 8, files: 1, bytes: 8, changed: 0 });
  });

  it("sync:true rides the same gate and reaches the relay", async () => {
    const from = await makeNode(userId);
    const to = await makeNode(userId);
    const src = attachScriptedNode(
      from,
      {
        tree_manifest: () => ({
          entries: [{ relPath: "f", size: 1, mtime: 1, sha256: "c".repeat(64) }],
          nextCursor: null,
        }),
        // The relay verifies the digest, so the fixture's must be the real
        // hash of the window bytes ("abcd"), not a stand-in.
        archive_create: () => ({
          size: 4,
          sha256: new Bun.CryptoHasher("sha256").update(Buffer.from("abcd")).digest("hex"),
        }),
        file_read: (cmd) =>
          cmd.type === "file_read" ? { bytes_b64: "YWJjZA==", next: 4, size: 4 } : new Error("wrong"),
        remove_paths: () => undefined,
      },
      { dataDir: "/sd1" },
    );
    const dst = attachScriptedNode(
      to,
      {
        tree_manifest: () => ({ entries: [], nextCursor: null }),
        transfer_write: (cmd) =>
          cmd.type === "transfer_write"
            ? { path: cmd.path, received: Buffer.from(cmd.chunkB64, "base64").byteLength }
            : new Error("wrong"),
        archive_extract: () => ({ files: 1, bytes: 4 }),
        remove_paths: () => undefined,
      },
      { dataDir: "/sd2" },
    );
    scripted.push(src, dst);
    const res = await app.fetch(
      authedRequest("/api/transfers", session, {
        method: "POST",
        body: body({ nodeId: from, path: "/s" }, { nodeId: to, path: "/d" }, true),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sync: true, archiveBytes: 4, files: 1, bytes: 4, changed: 1 });
  });
});
