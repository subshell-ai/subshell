import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import * as nodeRpc from "@/services/nodes/node-rpc.js";
import { revokeSubshellToken } from "@/services/subshell-tokens.js";
import { detectRuntimeSessionHarnesses, sessionHarnesses } from "../harness-detect.js";
import { RuntimeSessionLauncher } from "../runtime-session-launcher.js";
import { RUNTIME_PANE_BASE_URL, SshRuntimeSession } from "../session.js";
import { registerSession, resetSessionRegistryForTests, sessionHooks } from "../session-registry.js";
import { SshRuntimeSessionsRepository } from "../sessions.repository.js";
import { SshRuntimeRefusal } from "../sessions.service.js";
import { sessionLaunchHarness } from "../sessions-lifecycle.js";

/**
 * The task-25 plane seam, at the three doors this wave owns:
 *
 * - **Attribution**: a `rest_request` carrying a `paneId` is honored for a pane
 *   the session really issued and refuses a forged one; a frame WITHOUT a
 *   paneId keeps the slice's shared-door rule (one pane or nothing). Multi-pane
 *   attribution works with NO credential on the wire, and the one-pane surface
 *   does not regress.
 * - **The bake**: a runtime pane env names its OWN door, the never-resolves
 *   sentinel and the destination data dir - and no minted token ever appears
 *   in a launch frame or a pane env (the HARD invariant, design §5), scanned.
 * - **The detect verbs**: capability refusal named (`detect_unsupported`), the
 *   round trip merging into the hidden runtime node row's `inventory_json`
 *   (the mirror write), and the cached read answering without a round trip.
 *
 * The broker is the module mock (the sessions-close pattern): every outbound
 * `sendCommand` is captured, and `ssh_session_send` payloads are decoded so
 * the inner runtime frame (launch, detect) is asserted where it actually
 * rides.
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);

const email = `panedoors-${crypto.randomUUID()}@subshell.local`;
let userId: string;
const cleanupNodes: string[] = [];

interface Captured {
  nodeId: string;
  cmd: { type: string; ref?: string; data_b64?: string };
  inner?: Record<string, unknown>;
}
const captured: Captured[] = [];
let pumpTarget: SshRuntimeSession | undefined;
/** The detect answer the pump gives back (set per test). */
let detectAnswer: { results: unknown[]; env: Record<string, string> } | undefined;

function hello(caps: string[]): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: caps,
    homeDir: "/home/dst",
    dataDir: "/home/dst/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-ab12cd34ef56",
    paneCount: 0,
  };
}

const ALL_CAPS = ["ssh-runtime", "callback-sock", "detect", "pane-callback-sock"];

async function mkSession(caps: string[] = ALL_CAPS): Promise<SshRuntimeSession> {
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId, connectingNodeId);
  await nodesRepo.create({
    id: connectingNodeId,
    ownerUserId: userId,
    name: `pd-${sessionId.slice(0, 8)}`,
    kind: "agent",
  });
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `pd-rt-${sessionId.slice(0, 8)}`,
    kind: NODE_KIND_RUNTIME,
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: userId,
    connectingNodeId,
    runtimeNodeId,
    alias: "pd",
    host: "127.0.0.1",
    port: 22,
    user: null,
    status: "active",
  });
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(hello(caps)));
  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: userId,
    connectingNodeId,
    runtimeNodeId,
    target: { alias: "pd", host: "127.0.0.1", port: 22, user: null, identityFile: null },
    hello: hello(caps),
  });
  session.hooks = sessionHooks(); // the REAL hook object; executeCallback self-fetch would 504 - the recorded plumbing is the assertion
  registerSession(session);
  return session;
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("pd-pass-1"),
    role: "user",
  });
  mock.module("@/services/nodes/node-rpc.js", () => ({
    ...nodeRpc,
    sendCommand: async (nodeId: string, cmd: Captured["cmd"]) => {
      const entry: Captured = { nodeId, cmd };
      if (cmd.type === "ssh_session_send" && pumpTarget !== undefined) {
        const frames = new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64 ?? "", "base64")));
        entry.inner = frames[0] as Record<string, unknown>;
        captured.push(entry);
        // Every framed command gets an answer (launch included - an unanswered
        // command would sit on the session's 20 s deadline): detect answers
        // with the fixture's rows/env, everything else with an empty success.
        const inner = entry.inner as { type?: string; ref?: string } | undefined;
        if (inner?.ref !== undefined) {
          pumpTarget.ingestBytes(
            encodeSshSessionFrame({
              type: "result",
              ref: inner.ref,
              ok: true,
              ...(inner.type === "detect" && detectAnswer !== undefined ? { data: detectAnswer } : {}),
            }),
          );
        }
        return { ok: true };
      }
      captured.push(entry);
      return { ok: true };
    },
  }));
});

afterAll(async () => {
  mock.module("@/services/nodes/node-rpc.js", () => ({ ...nodeRpc }));
  resetSessionRegistryForTests();
  // Take the session ROWS with us: an unsettled `active` row outlives the
  // file and joins the next file's boot-sweep census (the stale-row hygiene
  // the sessions-close fixture learned the same way - its rows settle closed).
  await db
    .deleteFrom("sshRuntimeSessions")
    .where("ownerUserId", "=", userId)
    .execute()
    .catch(() => {});
  for (const id of cleanupNodes) {
    await db
      .deleteFrom("nodes")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
  }
  await deleteUserByEmailOrId(email).catch(() => {});
});

describe("rest_request paneId plumbing", () => {
  test("a frame naming a real pane reaches execute as that pane; a forged attribution refuses", async () => {
    const session = await mkSession();
    const paneA = crypto.randomUUID();
    const paneB = crypto.randomUUID();
    session.registerPane(paneA, "token-A-plaintext");
    const hooks = sessionHooks();
    // The door rule, straight from the registry's real hook:
    expect(hooks.resolveCallbackPane(session, `/api/subshells/${paneA}`, "GET", paneA)).toBe(paneA);
    expect(hooks.resolveCallbackPane(session, `/api/subshells/${paneB}`, "GET", paneB)).toBeNull(); // not this session's pane
    expect(hooks.resolveCallbackPane(session, `/api/subshells/${paneA}`, "DELETE", paneA)).toBeNull(); // method gate rides through
    // Multi-pane with NO attribution (shared door): unresolvable; a single
    // pane keeps answering (the slice's rule, unregressed).
    session.registerPane(paneB, "token-B");
    expect(hooks.resolveCallbackPane(session, `/api/subshells/${paneA}`, "GET")).toBeNull();
    session.unregisterPane(paneB);
    expect(hooks.resolveCallbackPane(session, `/api/subshells/${paneA}`, "GET")).toBe(paneA);
    // The channels family (design §5's third allowlist line, task-25 gap close).
    expect(hooks.resolveCallbackPane(session, "/api/channels", "POST", paneA)).toBe(paneA);
    expect(hooks.resolveCallbackPane(session, "/api/channels/room/posts", "POST", paneA)).toBe(paneA);

    // And the plumbing: a pumped frame's paneId arrives at the hook.
    pumpTarget = session;
    const seen: { paneId?: string }[] = [];
    session.hooks = {
      ...hooks,
      resolveCallbackPane: (_s, _p, _m, framePaneId) => {
        seen.push({ paneId: framePaneId });
        return framePaneId ?? null;
      },
      executeCallback: async () => ({ status: 200, body: "{}" }),
    };
    session.ingestBytes(
      encodeSshSessionFrame({
        type: "rest_request",
        reqId: "q1",
        method: "GET",
        path: `/api/subshells/${paneA}`,
        paneId: paneA,
      }),
    );
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen[0]?.paneId).toBe(paneA);
  });
});

describe("runtime pane bake", () => {
  test("a preset launch frames the registration block and NO credential material", async () => {
    const session = await mkSession();
    const pane = crypto.randomUUID();
    const TOKEN = "subshell_SECRETSCAN_9f3a1c"; // planted: must never appear in a frame or a pane env
    session.registerPane(pane, TOKEN);
    pumpTarget = session;
    captured.length = 0;
    const launcher = new RuntimeSessionLauncher(session);
    const configPath = `${session.hello.dataDir}/mcp/${pane}.json`;
    const subshellEnv = {
      SUBSHELL_ID: pane,
      SUBSHELL_NAME: "pd pane",
      SUBSHELL_RUNTIME_CALLBACK_SOCK: session.paneCallbackSockPath(pane),
      SUBSHELL_DATA_DIR: session.hello.dataDir,
      SUBSHELL_BASE_URL: RUNTIME_PANE_BASE_URL,
    };
    const harness = {
      id: "claude-code",
      name: "Claude Code",
      detectSpec: { binaryName: "claude", envOverride: "", knownPaths: [] },
      buildCommand: ({ binary, mcp }: { binary: string; mcp?: { args?: string[] } }) => [binary, ...(mcp?.args ?? [])],
    } as never;
    await launcher.launch({
      id: pane,
      socket: "sock-x",
      harness,
      binary: "",
      cwd: "/home/dst/work",
      preset: { name: "p", description: null, env: {}, flags: [], settings: null, configIsolation: false },
      subshellName: "pd pane",
      subshellEnv,
      mcp: {
        fileContent: JSON.stringify({ mcpServers: { subshell: { command: "subshell", args: ["mcp"] } } }),
        args: ["--mcp-config", configPath],
      },
      mcpConfigPath: configPath,
      reporter: { command: "subshell", args: ["report"] },
    });
    const launchCmd = captured.find((c) => c.inner?.type === "launch");
    expect(launchCmd, "the launch frame must reach the broker").toBeDefined();
    const cmd = launchCmd?.inner?.cmd as Record<string, unknown>;
    expect(cmd.mcp).toBeDefined(); // preset parity: the registration rides the frame
    expect((cmd.mcp as { path: string }).path).toBe(configPath);
    expect(cmd.argv as string[]).toContain("--mcp-config");
    // THE HARD INVARIANT (design §5), scanned on every surface that crosses:
    const wire = JSON.stringify([captured.map((c) => c.inner)]);
    expect(wire).not.toContain(TOKEN);
    expect(JSON.stringify(cmd.subshellEnv)).not.toContain(TOKEN);
    // Door + sentinel + destination data dir present; no key, no plane URL.
    expect(subshellEnv.SUBSHELL_RUNTIME_CALLBACK_SOCK).toBe(`${session.hello.dataDir}/callbacks/${pane}.sock`);
    expect(subshellEnv.SUBSHELL_BASE_URL).toBe("http://subshell-callback.invalid");
    expect("SUBSHELL_API_KEY" in subshellEnv).toBe(false);
  });
});

describe("launch-harness (the real service path, credential scan)", () => {
  const cleanupPanes: string[] = [];
  const cleanupPresets: string[] = [];
  const presetsRepo = new PresetsRepository(db);
  const subshellsRepo = new SubshellsRepository(db);

  async function ownPreset(env: Record<string, string>): Promise<string> {
    const row = await presetsRepo.create({
      id: crypto.randomUUID(),
      userId,
      harnessId: "claude-code",
      name: `pd-preset-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: JSON.stringify(env),
      flagsJson: JSON.stringify([]),
      settingsJson: null,
      configIsolation: 0,
    });
    cleanupPresets.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    for (const id of cleanupPanes) {
      await revokeSubshellToken(id).catch(() => {});
      await subshellsRepo.delete(id).catch(() => {});
    }
    for (const id of cleanupPresets) {
      await db
        .deleteFrom("presets")
        .where("id", "=", id)
        .execute()
        .catch(() => {});
    }
  });

  test("a presetless harness launch bakes the plan from the hello facts and NO credential crosses", async () => {
    const session = await mkSession();
    pumpTarget = session;
    captured.length = 0;
    const res = await sessionLaunchHarness(session.id, userId, {
      harnessId: "claude-code",
      cwd: "/home/dst/work",
    });
    cleanupPanes.push(res.subshellId);
    // The REAL minted token (not a planted literal this time): whatever it is,
    // it must appear in no frame and no pane env (design §5's invariant on the
    // new path, held by the same scan as the sibling's bake test).
    const token = session.paneToken(res.subshellId);
    expect(typeof token).toBe("string");
    const launchCmd = captured.find((c) => c.inner?.type === "launch");
    expect(launchCmd, "the launch frame must reach the broker").toBeDefined();
    const cmd = launchCmd?.inner?.cmd as Record<string, unknown>;
    expect(cmd.harnessId).toBe("claude-code");
    // Baked from the HELLO facts, not the plane's paths: the destination's own
    // data dir for the MCP registration, its own resolve rule for the binary.
    expect((cmd.mcp as { path: string }).path).toBe(`${session.hello.dataDir}/mcp/${res.subshellId}.json`);
    expect((cmd.resolve as { binaryName: string }).binaryName).toBe("claude");
    expect(cmd.argv as string[]).toContain("--mcp-config");
    // Fresh start-mode conversation for a resume-capable harness, and the
    // same id pinned on the row (the census's later reader).
    const hs = cmd.harnessSession as { id: string; mode: string };
    expect(hs.mode).toBe("start");
    const row = await subshellsRepo.findById(res.subshellId);
    expect(row?.harnessId).toBe("claude-code");
    expect(row?.presetId).toBeNull();
    expect(row?.nodeId).toBe(session.runtimeNodeId);
    expect(row?.harnessSessionId).toBe(hs.id);
    // THE HARD INVARIANT, scanned on every surface that crosses:
    const wire = JSON.stringify([captured.map((c) => c.inner)]);
    expect(wire).not.toContain(token as string);
    expect(wire).not.toContain("SUBSHELL_API_KEY");
    expect(JSON.stringify(cmd.subshellEnv)).not.toContain(token as string);
    // Door + sentinel + destination data dir; the plane URL is the sentinel,
    // never the real one.
    const paneEnv = cmd.subshellEnv as Record<string, string>;
    expect(paneEnv.SUBSHELL_RUNTIME_CALLBACK_SOCK).toBe(`${session.hello.dataDir}/callbacks/${res.subshellId}.sock`);
    expect(paneEnv.SUBSHELL_BASE_URL).toBe(RUNTIME_PANE_BASE_URL);
    expect(paneEnv.SUBSHELL_DATA_DIR).toBe(session.hello.dataDir);
    expect("SUBSHELL_API_KEY" in paneEnv).toBe(false);
    // The reporter half baked into the argv (hooks re-enter the destination's
    // own binary; a reporter-less plugin omits the hooks - claude has one):
    expect(JSON.stringify(cmd.argv)).toContain("report");
  });

  test("a preset launch rides the frame (preset env is user data, never the credential layer)", async () => {
    const session = await mkSession();
    pumpTarget = session;
    const presetId = await ownPreset({ PD_SCAN_MODEL: "svc-scan-model" });
    captured.length = 0;
    const res = await sessionLaunchHarness(session.id, userId, {
      harnessId: "claude-code",
      presetId,
      cwd: "/home/dst/work",
    });
    cleanupPanes.push(res.subshellId);
    const token = session.paneToken(res.subshellId) as string;
    const launchCmd = captured.find((c) => c.inner?.type === "launch");
    const cmd = launchCmd?.inner?.cmd as Record<string, unknown>;
    const preset = cmd.preset as { name: string; env: Record<string, string> };
    expect(preset.env.PD_SCAN_MODEL).toBe("svc-scan-model");
    const row = await subshellsRepo.findById(res.subshellId);
    expect(row?.presetId).toBe(presetId);
    const wire = JSON.stringify([captured.map((c) => c.inner)]);
    expect(wire).not.toContain(token);
    expect(wire).not.toContain("SUBSHELL_API_KEY");
  });

  test("input guards refuse BEFORE any row is written (unknown harness, foreign preset, mismatch)", async () => {
    const session = await mkSession();
    await expect(
      sessionLaunchHarness(session.id, userId, { harnessId: "not-a-harness", cwd: "/home/dst/work" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      sessionLaunchHarness(session.id, userId, {
        harnessId: "claude-code",
        presetId: crypto.randomUUID(),
        cwd: "/home/dst/work",
      }),
    ).rejects.toMatchObject({ status: 404 });
    const presetId = await ownPreset({ ANTHROPIC_MODEL: "mismatch-check" });
    await expect(
      sessionLaunchHarness(session.id, userId, { harnessId: "terminal", presetId, cwd: "/home/dst/work" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      sessionLaunchHarness(session.id, "someone-else", { harnessId: "claude-code", cwd: "/x" }),
    ).rejects.toBeInstanceOf(SshRuntimeRefusal);
    const rows = await subshellsRepo.listByUser(userId);
    expect(rows.filter((r) => r.nodeId === session.runtimeNodeId).length).toBe(0);
  });
});

describe("harness-detect verbs", () => {
  test("capability refusal: a runtime without detect answers the named 409", async () => {
    const session = await mkSession(["ssh-runtime", "callback-sock"]);
    await expect(detectRuntimeSessionHarnesses(session.id, userId)).rejects.toMatchObject({
      status: 409,
      code: "detect_unsupported",
    });
  });

  test("a foreign owner reads 404 on both verbs", async () => {
    const session = await mkSession();
    await expect(detectRuntimeSessionHarnesses(session.id, "someone-else")).rejects.toBeInstanceOf(SshRuntimeRefusal);
    await expect(sessionHarnesses(session.id, "someone-else")).rejects.toMatchObject({ status: 404 });
  });

  test("the round trip asks with plane-owned rules, merges into the node row, and the cached read answers", async () => {
    const session = await mkSession();
    pumpTarget = session;
    detectAnswer = {
      results: [
        { harnessId: "claude-code", installed: true, binaryPath: "/usr/local/bin/claude", rawVersion: "claude 9.9.9" },
      ],
      env: { CLAUDE_CONFIG_DIR: "/home/dst/.claude" },
    };
    captured.length = 0;
    const view = await detectRuntimeSessionHarnesses(session.id, userId, ["claude-code"]);
    expect(view.online).toBe(true);
    expect(view.env.CLAUDE_CONFIG_DIR).toBe("/home/dst/.claude");
    const claude = view.harnesses.find((h) => h.harnessId === "claude-code");
    expect(claude?.installed).toBe(true);
    expect(claude?.binaryPath).toBe("/usr/local/bin/claude");
    expect(claude?.rawVersion).not.toBeNull();
    // The frame the plane SENT: plane-owned specs (filtered to the ask),
    // name-only env. (envNames is the FULL enabled union; specs the subset.)
    const detectFrame = captured.find((c) => c.inner?.type === "detect");
    expect(detectFrame).toBeDefined();
    const specs = detectFrame?.inner?.specs as { id: string }[];
    expect(specs.map((s) => s.id)).toEqual(["claude-code"]);
    expect(Array.isArray(detectFrame?.inner?.envNames)).toBe(true);
    // The mirror write landed on the hidden runtime node row.
    const node = await nodesRepo.findById(session.runtimeNodeId);
    expect(node?.inventoryJson).toContain("claude-code");
    // The cached read answers with no new round trip.
    captured.length = 0;
    const cached = await sessionHarnesses(session.id, userId);
    expect(captured.length).toBe(0); // pure read: the broker stayed silent
    expect(cached.harnesses.some((h) => h.harnessId === "claude-code")).toBe(true);
    expect(cached.env.CLAUDE_CONFIG_DIR).toBe("/home/dst/.claude");
  });
});
