import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tmuxSocketFor } from "@internal/pane-runtime";
import { type NodeCommandBody, parseNodeCommandBody } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * Task 14 — the cross-stack integration suite: everything phase-2 shipped
 * (registry, signed RPC, RemoteLauncher, manager routing, node resolution,
 * the uploads relay, the ws relay) meets over REAL routes with a REAL scripted
 * agent. Nothing here mocks the RPC layer: every frame the tests assert was
 * signed by the control key, pushed through `sendCommand`, decoded by the
 * scripted node (base64url payload split — no verify, tests trust themselves)
 * and gated through the same `parseNodeCommandBody` the agent switches on.
 *
 * Fixture shape (enroll-less): the `nodes` row is written directly by the
 * repository and the scripted agent enters through `attachScriptedNode` — the
 * dial-in/upgrade auth path is `node-ws-integration.test.ts`'s own ground.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { seedProfile } from "@/services/__tests__/helpers/seed-profile.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import {
  attachScriptedNode,
  ok,
  probeAllAlive,
  SCRIPTED_DATA_DIR,
  type ScriptedHandler,
  type ScriptedNode,
  statDirEcho,
} from "@/test-helpers/scripted-node.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(uploadsRoutes);

/** The 512 KiB wire budget as a literal — importing the constant would let drift pass. */
const CHUNK = 512 * 1024;

/** Deterministic filler — no file-type magic at any sniff offset (pinned by the uploads suite). */
function payload(size: number): Uint8Array {
  return new Uint8Array(size).fill(0xab);
}

/** The lifecycle the scripted node answers: every command these tests can trigger. */
const LIFECYCLE = {
  stat_dir: statDirEcho,
  launch: ok,
  terminate: ok,
  kill: ok,
  input: ok,
  resize: ok,
  probe: probeAllAlive,
  prompt_deliver: () => ({ promptDelivered: true }),
  probe_resume: () => ({ canResume: true }),
  remove_paths: ok,
};

/** Narrowing helper: the launch variant of a captured command list. */
type LaunchCmd = Extract<NodeCommandBody, { type: "launch" }>;
function launches(sim: ScriptedNode): LaunchCmd[] {
  return sim.cmdsOf("launch") as LaunchCmd[];
}

describe("remote subshells over real routes (Task 14 lock-step)", () => {
  const email = `it-rem-${crypto.randomUUID()}@subshell.local`;
  const pw = "it-remote-pass-1";
  let userId: string;
  let cookie: string;
  let profileId: string;
  let nodeId: string;
  const createdSubshellIds: string[] = [];

  const subshellsRepo = new SubshellsRepository(db);
  const profilesRepo = new ProfilesRepository(db);
  const nodesRepo = new NodesRepository(db);

  async function post(path: string, body?: Record<string, unknown>, method = "POST") {
    return await app.fetch(authedRequest(path, cookie, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  }

  /** `POST /api/subshells` pinned to the scripted node; asserts the honest 200 shape. */
  async function createOnNode(extra: Record<string, unknown> = {}) {
    const res = await post("/api/subshells", {
      profileId,
      workingDir: "/srv/work/remote",
      nodeId,
      ...extra,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; tmuxSocket: string; promptDelivered: boolean };
    createdSubshellIds.push(body.id);
    return body;
  }

  beforeAll(async () => {
    await setupAuthTables();
    await ensureLocalNode(db);
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    cookie = await signIn(email, pw);
    profileId = await seedProfile(profilesRepo, { userId, name: "it-profile" });
    nodeId = crypto.randomUUID();
    await nodesRepo.create({ id: nodeId, ownerUserId: userId, name: `it-${nodeId}`, kind: "agent" });
    // FRESH installed-claude inventory: the strict §6.2 launch gate and the
    // RemoteLauncher's cached resolveBinary both read this row, never a probe.
    await nodesRepo.applyInventory(
      nodeId,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    // And the node's DECLARATION: since phase 2 a plugin is launchable only
    // when the node says it has it installed, so an inventory alone offers
    // nothing.
    await nodesRepo.recordPluginReport(nodeId, [
      {
        id: "claude-code",
        name: "Claude Code",
        type: "agent-harness",
        version: "1.0.0",
        description: "",
        capabilities: [],
      },
    ]);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await subshellsRepo.delete(id).catch(() => {});
    await nodesRepo.deleteById(nodeId);
    await db.deleteFrom("profiles").where("id", "=", profileId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("happy full lifecycle: launch frame on the wire, prompt delivered, nodeOffline across a detach, sweep partition", async () => {
    const sim = attachScriptedNode(nodeId, LIFECYCLE);
    let sim2: ScriptedNode | undefined;
    try {
      const body = await createOnNode({ name: "it-remote", prompt: "summarize the repo" });
      const id = body.id;
      expect(body.tmuxSocket).toBe(tmuxSocketFor(id));
      expect(body.promptDelivered).toBe(true);

      // Every command ran through the real signed RPC; the create path is
      // stat_dir → launch → prompt_deliver and NOTHING else (inventory is
      // cache-only, MCP composes without a round trip).
      expect(sim.cmdTypes()).toEqual(["stat_dir", "launch", "prompt_deliver"]);
      expect(sim.seqs()).toEqual([1, 2, 3]); // per-connection monotonic from 1

      const launch = launches(sim)[0];
      expect(launch.subshellId).toBe(id);
      expect(launch.socket).toBe(tmuxSocketFor(id));
      expect(launch.cwd).toBe("/srv/work/remote"); // stat_dir's echoed realpath
      expect(launch.harnessId).toBe("claude-code");
      expect(launch.subshellName).toBe("it-remote");
      expect(launch.profile.name).toBe("it-profile");
      // Pure remote MCP plan (spec §6.4): the path composes under the FAKE
      // dataDir the scripted `ready` advertised, content ships inline.
      expect(launch.mcp?.path).toBe(`${SCRIPTED_DATA_DIR}/mcp/${id}.json`);
      expect(launch.mcp?.fileContent).toContain("/usr/bin/subshell");
      // No local artifact write rode along — the content is the frame's.
      expect(sim.cmdTypes()).not.toContain("write_file");
      // Conversation pinned at start for later resume (claude-code has resume).
      expect(launch.harnessSession?.mode).toBe("start");
      expect(launch.harnessSession?.id).toBeTruthy();
      // The pane env names the NODE's dataDir (Task 9 override) + a real token.
      expect(launch.subshellEnv.SUBSHELL_DATA_DIR).toBe(SCRIPTED_DATA_DIR);
      expect(launch.subshellEnv.SUBSHELL_ID).toBe(id);
      expect(launch.subshellEnv.SUBSHELL_API_KEY).toBeTruthy();

      // Geometry passthrough, pinned honestly both ways: (1) NO control-plane
      // producer sets launch.cols/rows today — the route takes no geometry and
      // the local twin never sized newSubshell either (the first attach's
      // resize is what sizes a pane) — so the wire carries no geometry; (2)
      // the frozen protocol validates/passes the optional fields intact, so
      // the day a producer exists the frame reaches the agent's resizeWindow
      // (apps/node/agent/src/commands/launch.ts) without another protocol change.
      expect("cols" in launch).toBe(false);
      expect("rows" in launch).toBe(false);
      const withGeometry = parseNodeCommandBody({ ...launch, cols: 132, rows: 43 });
      expect(withGeometry).toMatchObject({ type: "launch", cols: 132, rows: 43 });

      // Agent-side settle loop as ONE round trip, manager defaults on the wire.
      const prompt = sim.cmdsOf("prompt_deliver")[0];
      expect(prompt).toEqual({
        type: "prompt_deliver",
        subshellId: id,
        text: "summarize the repo",
        settleTimeoutMs: 15_000,
        pollMs: 400,
      });

      // Views: nodeId stamped, node online.
      const view = async () =>
        (await (await post(`/api/subshells/${id}`, undefined, "GET")).json()) as {
          nodeId: string;
          nodeOffline: boolean;
          alive: boolean;
        };
      expect(await view()).toMatchObject({ nodeId, nodeOffline: false, alive: true });

      // Detach ⇒ the SAME row reads nodeOffline (registry probe, not DB).
      sim.detach();
      expect(await view()).toMatchObject({ nodeId, nodeOffline: true, alive: true });

      // §5.6 sweep partition: the offline node's rows are SKIPPED — not one
      // command fires, and the row keeps its alive stamp (absence of the
      // socket is not absence of the process). The sim-side zero checks are
      // NOT enough here: the socket is detached, so a regression removing the
      // manager's `!getLive` guard would reject inside `sendCommand` (the
      // offline pre-check in node-rpc.ts) before any frame is written — the
      // sim would stay silent and green. The injectable `sendNode` seam sees
      // the ATTEMPT, so zero counted sends is what actually pins the skip.
      const probeSends: NodeCommandBody[] = [];
      const manager = new SubshellManagerService({
        subshells: subshellsRepo,
        profiles: profilesRepo,
        sendNode: (nodeId, cmd, timeoutMs) => {
          probeSends.push(cmd);
          return sendCommand(nodeId, cmd, timeoutMs); // delegate — the re-attach sweep below still fires
        },
      });
      await manager.reconcile(userId);
      expect(sim.cmdTypes()).toHaveLength(3); // the create trio; nothing since
      expect(sim.countOf("probe")).toBe(0);
      expect(probeSends).toHaveLength(0);
      expect((await subshellsRepo.findById(id))?.alive).toBe(1);

      // Re-attach ⇒ the sweep's batched probe arrives for the row.
      sim2 = attachScriptedNode(nodeId, LIFECYCLE);
      await manager.reconcile(userId);
      expect(sim2.cmdsOf("probe")).toEqual([{ type: "probe", subshellIds: [id] }]);
      expect(probeSends).toHaveLength(1); // the stub is live — the offline zero was not an unwired stub
      expect((await view()).nodeOffline).toBe(false);

      // Leave the row terminated for a tidy afterAll.
      expect((await post(`/api/subshells/${id}/terminate`)).status).toBe(200);
      expect(sim2.countOf("kill")).toBe(1);
    } finally {
      sim.detach();
      sim2?.detach();
    }
  });

  it("terminate ⇒ `kill` on the wire, row retired", async () => {
    const sim = attachScriptedNode(nodeId, LIFECYCLE);
    try {
      const body = await createOnNode({ name: "it-term" });
      const before = sim.cmdTypes().length;

      const res = await post(`/api/subshells/${body.id}/terminate`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(sim.cmdTypes().slice(before)).toEqual(["kill"]);
      expect(sim.cmdsOf("kill")).toEqual([{ type: "kill", subshellId: body.id }]);

      const row = await subshellsRepo.findById(body.id);
      expect(row?.status).toBe("terminated");
      expect(row?.alive).toBe(0);
      const view = (await (await post(`/api/subshells/${body.id}`, undefined, "GET")).json()) as {
        status: string;
        alive: boolean;
      };
      expect(view).toMatchObject({ status: "terminated", alive: false });
    } finally {
      sim.detach();
    }
  });

  it("restart in place ⇒ kill, rotate, `probe_resume` first, relaunch with bestEffortLog on the wire", async () => {
    const sim = attachScriptedNode(nodeId, LIFECYCLE);
    try {
      const body = await createOnNode({ name: "it-restart" });
      const firstLaunch = launches(sim)[0];
      const storedId = firstLaunch.harnessSession?.id as string;

      const res = await post(`/api/subshells/${body.id}/restart`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: body.id, tmuxSocket: body.tmuxSocket, promptDelivered: false });

      // Wire order of the whole life so far: create (stat, launch), then the
      // in-place restart — kill the live pane, re-validate the dir, probe the
      // transcript, relaunch. (Binary resolve + MCP compose are cache/compute-
      // only; NO inventory round trip mid-restart.)
      expect(sim.cmdTypes()).toEqual(["stat_dir", "launch", "kill", "stat_dir", "probe_resume", "launch"]);

      const second = launches(sim)[1];
      // Revive parity: a pane this live must survive a lost replay-log pipe.
      expect("bestEffortLog" in firstLaunch).toBe(false); // create stays strict
      expect(second.bestEffortLog).toBe(true);
      // Resume rode on the stored conversation id, decided by the NODE's probe.
      expect(sim.cmdsOf("probe_resume")).toEqual([
        { type: "probe_resume", harnessId: "claude-code", harnessSessionId: storedId, cwd: "/srv/work/remote" },
      ]);
      expect(second.harnessSession).toEqual({ id: storedId, mode: "resume" });
      // Token rotation: the dead pane's baked key is replaced by a fresh one.
      expect(second.subshellEnv.SUBSHELL_API_KEY).toBeTruthy();
      expect(second.subshellEnv.SUBSHELL_API_KEY).not.toBe(firstLaunch.subshellEnv.SUBSHELL_API_KEY);
      // Same row, same id, same artifacts on the node.
      expect(second.subshellId).toBe(body.id);
      expect(second.mcp?.path).toBe(firstLaunch.mcp?.path);
    } finally {
      sim.detach();
    }
  });

  it("delete ⇒ kill + `remove_paths` naming log, mcp and meta paths; row gone", async () => {
    const sim = attachScriptedNode(nodeId, LIFECYCLE);
    try {
      const body = await createOnNode({ name: "it-delete" });
      const before = sim.cmdTypes().length;

      const res = await post(`/api/subshells/${body.id}`, undefined, "DELETE");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // The three artifacts a subshell leaves on a node go together (the log is
      // the replay artifact, the mcp config the shipped registration, the meta
      // the agent's own record a deliberate kill leaves behind on purpose).
      expect(sim.cmdTypes().slice(before)).toEqual(["kill", "remove_paths"]);
      expect(sim.cmdsOf("remove_paths")).toEqual([
        {
          type: "remove_paths",
          paths: [
            `${SCRIPTED_DATA_DIR}/subshells/${body.id}.log`,
            `${SCRIPTED_DATA_DIR}/mcp/${body.id}.json`,
            `${SCRIPTED_DATA_DIR}/subshells/${body.id}.meta.json`,
          ],
        },
      ]);
      expect(await subshellsRepo.findById(body.id)).toBeUndefined();
    } finally {
      sim.detach();
    }
  });

  describe("uploads relay through the same routes (Task 12 fixture, scripted agent)", () => {
    /**
     * A real-fs stand-in for the agent's `write_file` executor
     * (`apps/node/agent/src/commands/write-file.ts`, pinned by its own suite):
     * chunk 0 truncates a `.part` beside the target, later chunks append,
     * eof renames it into place — every accepted chunk answers the contractual
     * `{ path, received }`. Bytes land on an actual disk, so the eof
     * assertion below is about a real file, not a mock's bookkeeping.
     */
    function fsWriteFile(): { handler: ScriptedHandler; received: (path: string) => number } {
      const streams = new Map<string, { received: number; expected: number }>();
      const handler: ScriptedHandler = (cmd) => {
        if (cmd.type !== "write_file") return new Error(`fsWriteFile: wrong cmd ${cmd.type}`);
        const bytes = Buffer.from(cmd.chunk_b64, "base64");
        const tmp = `${cmd.path}.part`;
        let state = streams.get(cmd.path);
        if (cmd.chunk === 0) {
          mkdirSync(dirname(cmd.path), { recursive: true });
          writeFileSync(tmp, bytes, { mode: 0o600 });
          state = { received: bytes.byteLength, expected: 1 };
        } else {
          if (!state || cmd.chunk !== state.expected) return new Error(`write_file chunk ${cmd.chunk} has no stream`);
          appendFileSync(tmp, bytes);
          state.received += bytes.byteLength;
          state.expected += 1;
        }
        streams.set(cmd.path, state);
        if (cmd.eof) renameSync(tmp, cmd.path);
        return { path: cmd.path, received: state.received };
      };
      return { handler, received: (p) => streams.get(p)?.received ?? -1 };
    }

    /** A running agent-node row (direct repo insert — the relay reads it, no launch). */
    async function mkRow(workingDir: string): Promise<string> {
      const id = crypto.randomUUID();
      createdSubshellIds.push(id);
      await subshellsRepo.create({
        id,
        userId,
        name: "it-upload",
        workingDir,
        harnessId: "claude-code",
        profileId,
        status: "running",
        tmuxSocket: `subshell-it-${id.slice(0, 8)}`,
        nodeId,
      });
      return id;
    }

    async function upload(subshellId: string, file: File) {
      const form = new FormData();
      form.set("file", file);
      return await app.fetch(
        authedRequest(`/api/subshells/${subshellId}/uploads`, cookie, { method: "POST", body: form }),
      );
    }

    it("relays 1 MiB as two awaited 512 KiB chunks; the node-side file equals the payload", async () => {
      const nodeDir = mkdtempSync(join(tmpdir(), "subshell-it-node-"));
      const ws = join(nodeDir, "ws");
      const subshellId = await mkRow(ws);
      const fs = fsWriteFile();
      const sim = attachScriptedNode(nodeId, { write_file: fs.handler });
      try {
        const res = await upload(
          subshellId,
          new File([payload(1048576)], "big.bin", { type: "application/octet-stream" }),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as { path: string; name: string; size: number; contentType: string };

        const cmds = sim.cmdsOf("write_file");
        expect(cmds.map((c) => c.chunk)).toEqual([0, 1]);
        expect(cmds.map((c) => c.eof)).toEqual([false, true]);
        expect(cmds.map((c) => Buffer.from(c.chunk_b64, "base64").byteLength)).toEqual([CHUNK, CHUNK]);
        expect(cmds.every((c) => c.path === json.path)).toBe(true);

        expect(json.name).toMatch(/^\d{8}-\d{6}-big-[0-9a-f]{8}\.bin$/);
        expect(json.path).toBe(join(ws, ".subshell", "uploads", json.name));
        expect(json.size).toBe(1048576);
        // The file the frame sequence actually produced on the "node":
        expect(readFileSync(json.path)).toEqual(Buffer.from(payload(1048576)));
        expect(existsSync(join(nodeDir, ".subshell"))).toBe(false); // only under ws
      } finally {
        sim.detach();
        rmSync(nodeDir, { recursive: true, force: true });
      }
    });

    /**
     * Raw multipart for a ZERO-byte part. Bun's `Request.formData()` drops the
     * `filename=` parameter of an empty part (verified on 1.4.0: name comes
     * back undefined however the body is built), so `safeUploadName` falls
     * back to `pasted` — and that is equally true of the LOCAL upload path
     * (same route, same parser), so it is a runtime trait, not relay logic.
     * Going through FormData outright would hide that even the client's MIME
     * is what survives, so the wire bytes are spelled here.
     */
    function emptyUploadRequest(subshellId: string, name: string): Request {
      const boundary = `----moteit${crypto.randomUUID().replace(/-/g, "")}`;
      const raw =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n\r\n" +
        `--${boundary}--\r\n`;
      return authedRequest(`/api/subshells/${subshellId}/uploads`, cookie, {
        method: "POST",
        body: raw,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      });
    }

    it("a ZERO-BYTE upload terminates the write with one empty eof chunk and yields a real 0-byte file", async () => {
      const nodeDir = mkdtempSync(join(tmpdir(), "subshell-it-node0-"));
      const ws = join(nodeDir, "ws");
      const subshellId = await mkRow(ws);
      const fs = fsWriteFile();
      const sim = attachScriptedNode(nodeId, { write_file: fs.handler });
      try {
        const res = await app.fetch(emptyUploadRequest(subshellId, "empty.bin"));
        expect(res.status).toBe(200);
        const json = (await res.json()) as { path: string; name: string; size: number; contentType: string };

        // Exactly one frame: chunk 0 IS the eof, payload empty — the sequence
        // still terminates the stream (writeUploadRemote's `max(1, …)` rule).
        const cmds = sim.cmdsOf("write_file");
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ chunk: 0, eof: true, chunk_b64: "", path: json.path });

        expect(json.size).toBe(0);
        // The name shape is the honest one (see emptyUploadRequest): Bun drops
        // the empty part's filename, `pasted` + the collision-suffix tag is
        // what survives — local path would produce the same.
        expect(json.name).toMatch(/^\d{8}-\d{6}-pasted-[0-9a-f]{8}$/);
        expect(json.path).toBe(join(ws, ".subshell", "uploads", json.name));
        expect(json.contentType).toBe("application/octet-stream");
        // The write really landed: a 0-byte file at the target, no stray .part.
        expect(existsSync(json.path)).toBe(true);
        expect(statSync(json.path).size).toBe(0);
        expect(existsSync(`${json.path}.part`)).toBe(false);
        expect(fs.received(json.path)).toBe(0);
      } finally {
        sim.detach();
        rmSync(nodeDir, { recursive: true, force: true });
      }
    });
  });
});
