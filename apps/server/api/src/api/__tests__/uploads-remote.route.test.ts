import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import {
  attachConnection,
  detachConnection,
  type NodeConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Route-level contract for the terminal-upload relay to agent nodes (spec
 * §3.4): a subshell pinned to an agent node NEVER touches the backend's
 * filesystem — the file ships as ordered `write_file` chunks over the signed
 * RPC, and every failure maps to the structured error contract:
 * offline pre-gate / mid-stream disconnect → 409 `NODE_OFFLINE`, agent
 * refusal or a short `received` total → 409 `NODE_UNREACHABLE` with a generic
 * message (agent error text is unpinned protocol-side, so it is never echoed
 * to the browser), a locally-composed target that is not an absolute path →
 * 400 without a single frame.
 *
 * The fake agent stands in for the real `write_file` executor
 * (`apps/node/agent/src/commands/write-file.ts`, pinned by its own tests): it
 * captures every command by unwrapping the signed envelope the RPC put on the
 * wire and answers each chunk with the `{ path, received }` result the agent
 * is contractually required to echo. Chunk indices arriving 0,1,2… in wire
 * order is contractual — the tests below are what pin THAT from the
 * backend's side.
 */

const password = "upload-remote-pass-1";
/**
 * The 512 KiB wire budget, spelled as a literal on purpose: importing the
 * service's own constant would let a drift to the spec's (wrong, frame-
 * overflowing) 768 KiB pass these tests unnoticed.
 */
const CHUNK = 512 * 1024;

/** Deterministic filler — no file-type magic at any sniff offset (verified). */
function payload(size: number): Uint8Array {
  return new Uint8Array(size).fill(0xab);
}

/** Builds a multipart upload request carrying one file. */
function uploadRequest(subshellId: string, token: string, file: File): Request {
  const body = new FormData();
  body.set("file", file);
  return authedRequest(`/api/subshells/${subshellId}/uploads`, token, { method: "POST", body });
}

/** The `write_file` slice of the command union (the relay's only command). */
type WriteFileCmd = Extract<NodeCommandBody, { type: "write_file" }>;

/** Script overrides for the fake agent's answers. */
interface FakeAgentScript {
  /** Chunk index that answers `ok:false` (every earlier chunk is accepted). */
  failAt?: number;
  /** Added to the running total in the `eof` answer (short-read simulation). */
  eofReceivedDelta?: number;
  /** After answering this chunk index, the node's socket goes away. */
  offlineAfter?: number;
}

/** Recording fake agent attached to the live-connection registry. */
interface FakeAgent {
  /** Every `write_file` command body, in wire order. */
  readonly cmds: WriteFileCmd[];
  /** Evict the connection (idempotent) — for offline-transition scripts. */
  detach(): void;
}

/**
 * Attach a fake agent for `nodeId`: each `send` unwraps the envelope's
 * claims (decode-only — signature verification is node-rpc's own suite),
 * records the command, and settles the pending RPC exactly as the WS handler
 * would (`resolveResult`). Answers are synchronous, so chunk order in
 * `cmds` equals wire order with no scheduling noise.
 */
function attachFakeAgent(nodeId: string, script: FakeAgentScript = {}): FakeAgent {
  const cmds: WriteFileCmd[] = [];
  let received = 0;
  let conn: NodeConnection;
  const ws: NodeSocket = {
    send(data) {
      const frame = JSON.parse(String(data)) as { jws?: string };
      if (typeof frame.jws !== "string") throw new Error("fake agent: envelope is not { jws }");
      const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        jti: string;
        cmd: NodeCommandBody;
      };
      if (claims.cmd.type !== "write_file") throw new Error(`fake agent: unexpected cmd "${claims.cmd.type}"`);
      const cmd = claims.cmd;
      cmds.push(cmd);
      received += Buffer.from(cmd.chunk_b64, "base64").byteLength;
      const i = cmds.length - 1;
      if (script.failAt === i) {
        resolveResult(conn, { type: "result", ref: claims.jti, ok: false, error: `scripted refusal at chunk ${i}` });
      } else {
        resolveResult(conn, {
          type: "result",
          ref: claims.jti,
          ok: true,
          data: { path: cmd.path, received: received + (cmd.eof ? (script.eofReceivedDelta ?? 0) : 0) },
        });
      }
      if (script.offlineAfter === i) detachConnection(nodeId, ws);
      return 0;
    },
    close: () => {},
  };
  conn = attachConnection(nodeId, ws);
  return { cmds, detach: () => detachConnection(nodeId, ws) };
}

describe("uploads relay to agent nodes (spec §3.4)", () => {
  let ownerId: string;
  let ownerEmail: string;
  let ownerToken: string;
  const workDirs: string[] = [];
  const createdSubshellIds: string[] = [];
  const createdNodeIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    ownerEmail = `uprem-${crypto.randomUUID()}@subshell.local`;
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    ownerToken = await signIn(ownerEmail, password);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) {
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    }
    for (const id of createdNodeIds) await new NodesRepository(db).deleteById(id);
    await deleteUserByEmailOrId(ownerEmail);
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  /** Creates an agent node row (subshells.node_id has a real FK). */
  async function mkAgentNode(): Promise<string> {
    const id = crypto.randomUUID();
    createdNodeIds.push(id);
    await new NodesRepository(db).create({
      id,
      ownerUserId: ownerId,
      name: `uprem-${id}`,
      kind: "agent",
      status: "offline",
    });
    return id;
  }

  /** Inserts a subshell row owned by the caller, pinned to `nodeId`. */
  async function makeSubshell(workingDir: string, nodeId: string): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      name: "uprem-test",
      workingDir,
      harnessId: "claude-code",
      presetId: crypto.randomUUID(),
      status: "running",
      tmuxSocket: `subshell-uprem-${id.slice(0, 8)}`,
      nodeId,
    });
    return id;
  }

  function tempWorkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "subshell-uprem-route-"));
    workDirs.push(dir);
    return dir;
  }

  it("relays a 1 MiB file as exactly two 512 KiB chunks and answers the local response shape", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    const agent = attachFakeAgent(nodeId);
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File([payload(1048576)], "big.bin", { type: "application/octet-stream" })),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { path: string; name: string; size: number; contentType: string };

      expect(agent.cmds.map((c) => c.chunk)).toEqual([0, 1]);
      expect(agent.cmds.map((c) => c.eof)).toEqual([false, true]);
      expect(agent.cmds.map((c) => Buffer.from(c.chunk_b64, "base64").byteLength)).toEqual([CHUNK, CHUNK]);
      const reassembled = Buffer.concat(agent.cmds.map((c) => Buffer.from(c.chunk_b64, "base64")));
      expect(reassembled.equals(payload(1048576))).toBe(true);
      expect(agent.cmds.every((c) => c.path === json.path)).toBe(true);

      expect(json.name).toMatch(/^\d{8}-\d{6}-big-[0-9a-f]{8}\.bin$/);
      expect(json.path).toBe(join(ws, ".subshell", "uploads", json.name));
      expect(json.size).toBe(1048576);
      expect(json.contentType).toBe("application/octet-stream");
      // The relay composes the target as a STRING — the backend's own fs
      // (and the node-side git bookkeeping it would trigger) stays untouched.
      expect(existsSync(join(ws, ".subshell"))).toBe(false);
    } finally {
      agent.detach();
    }
  });

  it("gives two same-second relays of the same file distinct paths, each echoed by its own response", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    // Fresh fake agent per upload: its `received` total is stream-running,
    // and each relay is a fresh stream the agent restarts at 0.
    const agentA = attachFakeAgent(nodeId);
    const resA = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File([payload(8)], "dup.bin", { type: "application/octet-stream" })),
    );
    agentA.detach();
    const agentB = attachFakeAgent(nodeId);
    try {
      const resB = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File([payload(8)], "dup.bin", { type: "application/octet-stream" })),
      );
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const a = (await resA.json()) as { path: string; name: string };
      const b = (await resB.json()) as { path: string; name: string };

      // Suffix shape pinned: `YYYYMMDD-HHmmss-stem-<8hex>.ext` — still
      // timestamp-prefixed so recents sort, random-tagged before the ext.
      const shape = /^\d{8}-\d{6}-dup-[0-9a-f]{8}\.bin$/;
      expect(a.name).toMatch(shape);
      expect(b.name).toMatch(shape);
      // The agent receiver overwrites by contract, so within one second the
      // timestamp prefix alone collides — the two targets must differ, and
      // every frame of an upload must carry ITS OWN path.
      expect(a.path).not.toBe(b.path);
      expect(a.path).toBe(join(ws, ".subshell", "uploads", a.name));
      expect(b.path).toBe(join(ws, ".subshell", "uploads", b.name));
      expect(agentA.cmds.map((c) => c.path)).toEqual([a.path]);
      expect(agentB.cmds.map((c) => c.path)).toEqual([b.path]);
    } finally {
      agentB.detach();
    }
  });

  it("splits a 1,048,577-byte file into three chunks with a 1-byte tail", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    const agent = attachFakeAgent(nodeId);
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File([payload(1048577)], "tail.bin", { type: "application/octet-stream" })),
      );
      expect(res.status).toBe(200);
      expect(agent.cmds.map((c) => Buffer.from(c.chunk_b64, "base64").byteLength)).toEqual([CHUNK, CHUNK, 1]);
      expect(agent.cmds.map((c) => c.eof)).toEqual([false, false, true]);
    } finally {
      agent.detach();
    }
  });

  it("stops at a mid-stream refusal: 409 NODE_UNREACHABLE, generic body, no frames after the failing chunk", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    // 3 chunks of data, refusal on chunk 1 — a genuinely mid-stream failure.
    const agent = attachFakeAgent(nodeId, { failAt: 1 });
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(
          id,
          ownerToken,
          new File([payload(CHUNK * 2 + 10)], "mid.bin", { type: "application/octet-stream" }),
        ),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("NODE_UNREACHABLE");
      // Agent error strings are UNPINNED protocol-side (T6 ruling): the route
      // maps on ok/not-ok only and never echoes the refusal text to the browser.
      expect(body.message).not.toContain("scripted refusal");
      expect(agent.cmds.map((c) => c.chunk)).toEqual([0, 1]); // chunk 2 (the eof) never went out
    } finally {
      agent.detach();
    }
  });

  it("refuses an offline node with 409 NODE_OFFLINE before sending a single frame", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    // Attach then detach: the registry reads exactly "no live connection" and
    // the recording socket proves the pre-gate fired before any send.
    const agent = attachFakeAgent(nodeId);
    agent.detach();
    const res = await uploadsRoutes.fetch(
      uploadRequest(id, ownerToken, new File([payload(4)], "gone.bin", { type: "application/octet-stream" })),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
    expect(agent.cmds.length).toBe(0);
  });

  it("409s when the agent's eof `received` total disagrees with the byte count", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    const agent = attachFakeAgent(nodeId, { eofReceivedDelta: -1 });
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File([payload(10)], "short.bin", { type: "application/octet-stream" })),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("NODE_UNREACHABLE");
      expect(agent.cmds.length).toBe(1);
    } finally {
      agent.detach();
    }
  });

  it("maps a mid-stream disconnect to 409 NODE_OFFLINE with only the pre-drop frames sent", async () => {
    const nodeId = await mkAgentNode();
    const ws = tempWorkDir();
    const id = await makeSubshell(ws, nodeId);
    // Chunk 0 is answered, then the socket dies — chunk 1's sendCommand finds
    // no live connection (the offline twin of the refusal path — both 409,
    // distinct only by code: NODE_OFFLINE vs NODE_UNREACHABLE).
    const agent = attachFakeAgent(nodeId, { offlineAfter: 0 });
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(
          id,
          ownerToken,
          new File([payload(CHUNK + 10)], "drop.bin", { type: "application/octet-stream" }),
        ),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
      expect(agent.cmds.map((c) => c.chunk)).toEqual([0]);
    } finally {
      agent.detach();
    }
  });

  it("rejects a target that is not an absolute path with 400 and zero frames (never sign an empty path)", async () => {
    const nodeId = await mkAgentNode();
    const id = await makeSubshell("", nodeId); // composes ".subshell/uploads/<name>" — a relative target
    const agent = attachFakeAgent(nodeId);
    try {
      const res = await uploadsRoutes.fetch(
        uploadRequest(id, ownerToken, new File([payload(4)], "rel.bin", { type: "application/octet-stream" })),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("BAD_REQUEST");
      expect(agent.cmds.length).toBe(0);
    } finally {
      agent.detach();
    }
  });
});
