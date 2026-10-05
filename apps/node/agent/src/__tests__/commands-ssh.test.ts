import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  NODE_RESULT_MAINTENANCE,
  NODE_RESULT_SSH_GENERATION_STALE,
  type NodeCommandBody,
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
import { writeMaintenance } from "../maintenance.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * The SSH command arms, driven through `dispatchCommand` exactly as the
 * daemon drives them (posture copied from commands-archive-create.test.ts:
 * real temp dirs, a hand-built context, every answer run through the PROTOCOL
 * validator, refusals asserted by `ok:false` + exact message). The ssh binary
 * is the same recording shim the runtime suite uses — the arms are thin, so
 * these tests pin the THIN things: gates, exact refusal strings the plane
 * equality-matches, and validator-shaped answers.
 */

let base: string;
let savedSshPath: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-ssh-")));
  savedSshPath = process.env.SUBSHELL_SSH_PATH;
});

afterAll(() => {
  if (savedSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
  else process.env.SUBSHELL_SSH_PATH = savedSshPath;
  rmSync(base, { recursive: true, force: true });
});

/** Recording shim (mirrors the runtime test helper's shape, baked constants). */
function writeShim(
  dir: string,
  opts: { dashG?: string; sleep?: number; exitCode?: number } = {},
): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "shim.log");
  const lines = ["#!/bin/sh", `LOG='${log}'`, `printf 'ARGS:%s\\n' "$*" >> "$LOG"`];
  if (opts.dashG !== undefined) {
    lines.push(`for a in "$@"; do if [ "$a" = "-G" ]; then cat <<'GEOF'`);
    lines.push(opts.dashG);
    lines.push("GEOF\nexit 0\nfi; done");
  }
  if (opts.sleep !== undefined) lines.push(`exec sleep ${opts.sleep}`);
  lines.push(`exit ${opts.exitCode ?? 0}`);
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${lines.join("\n")}\n`, { mode: 0o755 });
  return { bin, log };
}

function setup(tag: string, sshBin: string): { dataDir: string; ctx: CommandContext } {
  const root = join(base, tag);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.SUBSHELL_SSH_PATH = sshBin; // the operator override the arm's ladder honors
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const ctx: CommandContext = {
    config,
    tmux: {
      calls: [] as string[][],
      newSubshell(socket: string, name: string, cwd: string, cmd: string) {
        (this as unknown as { calls: string[][] }).calls.push(["new", socket, name, cwd, cmd]);
      },
      pipePane(socket: string, name: string, file: string) {
        (this as unknown as { calls: string[][] }).calls.push(["pipe", socket, name, file]);
      },
      async resizeWindow(socket: string, name: string, cols: number, rows: number) {
        (this as unknown as { calls: string[][] }).calls.push(["resize", socket, name, String(cols), String(rows)]);
      },
      async listSubshellsChecked() {
        return { ok: true, names: [] } as const;
      },
      async hasSubshell() {
        return false;
      },
      async runAsync(args: string[]) {
        (this as unknown as { calls: string[][] }).calls.push(["run", ...args]);
        return { stdout: "", stderr: "" };
      },
    } as unknown as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => Date.now(),
    ws: { send: () => {} },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
  return { dataDir, ctx };
}

const SNAPSHOT: SshConnectionSnapshotWire = {
  alias: "app02",
  host: "app-02.example.com",
  user: "deploy",
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: ["/home/deploy/.ssh/known_hosts"],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
} as const;

const runIdFor = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digestFor = (seed: string) => {
  let h = 0;
  for (const c of seed) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
};

async function send(ctx: CommandContext, cmd: NodeCommandBody) {
  return await dispatchCommand(ctx, cmd);
}

describe("ssh_run_* arms", () => {
  it("start returns validator-shaped facts and refuses a re-used id with a different digest by the bare code", async () => {
    const shim = writeShim(join(base, "shim-run"));
    const { ctx } = setup("runs", shim.bin);
    const start = {
      type: "ssh_run_start",
      runId: runIdFor(1),
      snapshot: SNAPSHOT,
      remoteDir: null,
      command: "echo hi",
      deadlineMs: 30_000,
      requestDigest: digestFor("a"),
    } satisfies NodeCommandBody;
    const res = await send(ctx, start);
    expect(res.ok).toBe(true);
    expect(parseNodeSshRunFacts((res as { data?: unknown }).data)).not.toBeNull();
    const again = await send(ctx, { ...start, requestDigest: digestFor("b") } as NodeCommandBody);
    expect(again).toEqual({ ok: false, error: "run_conflict" });
  });

  it("status/read/cancel of an unknown id all answer the bare run_unknown code (never a start-retry path)", async () => {
    const shim = writeShim(join(base, "shim-unknown"));
    const { ctx } = setup("unknown", shim.bin);
    for (const type of ["ssh_run_status", "ssh_run_read", "ssh_run_cancel"] as const) {
      const body: NodeCommandBody =
        type === "ssh_run_read"
          ? { type, runId: runIdFor(77), stdoutFromByte: 0, stderrFromByte: 0, maxBytes: 1024, waitMs: 0 }
          : { type, runId: runIdFor(77) };
      expect(await send(ctx, body)).toEqual({ ok: false, error: "run_unknown" });
    }
    // a path-hostile id that the wire grammar allowed is ALSO run_unknown:
    // the handler gates composition before the store ever sees it
    expect(await send(ctx, { type: "ssh_run_status", runId: "../../escape" })).toEqual({
      ok: false,
      error: "run_unknown",
    });
  });

  it("a long-poll read that times out answers a validator-clean empty window with running facts", async () => {
    const shim = writeShim(join(base, "shim-poll"), { sleep: 5 });
    const { ctx } = setup("poll", shim.bin);
    const runId = runIdFor(2);
    await send(ctx, {
      type: "ssh_run_start",
      runId,
      snapshot: SNAPSHOT,
      remoteDir: "/srv/app",
      command: "sleepy",
      deadlineMs: 60_000,
      requestDigest: digestFor("p"),
    } as NodeCommandBody);
    const res = await send(ctx, {
      type: "ssh_run_read",
      runId,
      stdoutFromByte: 0,
      stderrFromByte: 0,
      maxBytes: 4096,
      waitMs: 300,
    } as NodeCommandBody);
    expect(res.ok).toBe(true);
    const read = parseNodeSshRunReadResult((res as { data?: unknown }).data);
    expect(read).not.toBeNull();
    expect(read!.lifecycle).toBe("running");
    expect(read!.stdoutB64).toBe("");
    await send(ctx, { type: "ssh_run_cancel", runId } as NodeCommandBody);
  }, 15_000);
});

describe("ssh_input_control arm", () => {
  it("applies a raising transition and answers the frozen NodeSshControlResult shape", async () => {
    const shim = writeShim(join(base, "shim-ctl"));
    const { ctx } = setup("ctl", shim.bin);
    const id = runIdFor(3);
    const res = await send(ctx, {
      type: "ssh_input_control",
      subshellId: id,
      mode: "human",
      generation: 4,
    } as NodeCommandBody);
    expect(res.ok).toBe(true);
    expect((res as { data?: unknown }).data).toEqual({ subshellId: id, mode: "human", generation: 4 });
  });

  it("a LOWER replayed generation is refused with the one frozen stale spelling (the plane equality-matches NodeRpcError.detail)", async () => {
    const shim = writeShim(join(base, "shim-ctl2"));
    const { ctx } = setup("ctl2", shim.bin);
    const id = runIdFor(4);
    await send(ctx, { type: "ssh_input_control", subshellId: id, mode: "human", generation: 9 } as NodeCommandBody);
    const stale = await send(ctx, {
      type: "ssh_input_control",
      subshellId: id,
      mode: "agent",
      generation: 8,
    } as NodeCommandBody);
    expect(stale).toEqual({ ok: false, error: NODE_RESULT_SSH_GENERATION_STALE });
  });

  it("refuses malformed pane ids before touching state", async () => {
    const shim = writeShim(join(base, "shim-ctl3"));
    const { ctx } = setup("ctl3", shim.bin);
    expect(
      await send(ctx, {
        type: "ssh_input_control",
        subshellId: "../bad",
        mode: "human",
        generation: 1,
      } as NodeCommandBody),
    ).toEqual({ ok: false, error: "invalid subshell id" });
  });
});

describe("ssh_terminal_launch arm", () => {
  it("launches ssh as the pane foreground under the allowlist env, records meta, and arms capture + watcher", async () => {
    const shim = writeShim(join(base, "shim-term"));
    const { dataDir, ctx } = setup("term", shim.bin);
    const id = runIdFor(5);
    const res = await send(ctx, {
      type: "ssh_terminal_launch",
      subshellId: id,
      socket: "sock-5",
      snapshot: SNAPSHOT,
      remoteDir: "/srv/app",
      cols: 120,
      rows: 30,
    } as NodeCommandBody);
    expect(res.ok).toBe(true);
    const meta = await ctx.meta.get(id);
    expect(meta?.harnessId).toBe("ssh");
    const calls = (ctx.tmux as unknown as { calls: string[][] }).calls;
    const newCall = calls.find((c) => c[0] === "new")!;
    const paneCmd = newCall![4]!;
    expect(paneCmd.startsWith("env -i ")).toBe(true);
    expect(paneCmd).toContain('TERM="$TERM"');
    expect(paneCmd).toContain(shim.bin); // the resolved binary, quoted into argv
    // the remote line is ONE quoted token: its inner quotes come back escaped
    expect(paneCmd).toContain("cd '\\''/srv/app'\\''");
    expect(paneCmd).toContain("&& exec");
    // No connecting-node shell, no credentials in the env:
    expect(paneCmd).not.toContain("SUBSHELL_API_KEY");
    expect(paneCmd).not.toContain(SNAPSHOT.alias); // argv is host-based; alias is display data
    const pipeCall = calls.find((c) => c[0] === "pipe")!;
    expect(pipeCall![3]).toBe(join(dataDir, "subshells", `${id}.log`)); // conventional path
    expect(ctx.watchers.has(id)).toBe(true);
    expect(calls.some((c) => c[0] === "resize" && c[3] === "120" && c[4] === "30")).toBe(true);
    // stop the watcher's tick: a mid-file death pass against the stub would
    // race sibling tests (the real daemon's exit path is covered elsewhere)
    if (ctx.watchTick !== undefined) clearInterval(ctx.watchTick);
    ctx.watchers.clear();
  });

  it("refuses maintenance with the bare constant, like launch does", async () => {
    const shim = writeShim(join(base, "shim-term2"));
    const { dataDir, ctx } = setup("term2", shim.bin);
    writeMaintenance(dataDir, { on: true, changedAt: new Date().toISOString() });
    const res = await send(ctx, {
      type: "ssh_terminal_launch",
      subshellId: runIdFor(6),
      socket: "sock-6",
      snapshot: SNAPSHOT,
      remoteDir: null,
    } as NodeCommandBody);
    expect(res).toEqual({ ok: false, error: NODE_RESULT_MAINTENANCE });
  });
});

describe("ssh_discover_aliases / ssh_resolve_config arms", () => {
  it("discovery answers through the validator with NAMES only from the account config", async () => {
    const shim = writeShim(join(base, "shim-disc"));
    setup("disc", shim.bin);
    const home = join(base, "disc-home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host alpha\n  HostName a.example\nHost beta\n  User x\n");
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.LOGNAME;
    process.env.HOME = home;
    try {
      const res = await dispatchCommand(
        { config: { dataDir: join(base, "disc", "data") } } as unknown as CommandContext,
        { type: "ssh_discover_aliases" } as NodeCommandBody,
      );
      expect(res.ok).toBe(true);
      const data = (res as { data?: JsonValue }).data as {
        aliases: string[];
        includeCycle: boolean;
        truncated: boolean;
      };
      expect(data.aliases).toEqual(["alpha", "beta"]);
    } finally {
      process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.LOGNAME = savedUserProfile;
    }
  });

  it("resolve runs ssh -G and returns the accepted outcome shape", async () => {
    const gOut = [
      "host resolved.example",
      "hostname resolved.example",
      "user deploy",
      "port 22",
      "userknownhostsfile /home/deploy/.ssh/known_hosts",
    ].join("\n");
    const shim = writeShim(join(base, "shim-res"), { dashG: gOut });
    setup("res", shim.bin);
    const home = join(base, "res-home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host app02\n  HostName resolved.example\n");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = await dispatchCommand(
        { config: { dataDir: join(base, "res", "data") } } as unknown as CommandContext,
        { type: "ssh_resolve_config", alias: "app02" } as NodeCommandBody,
      );
      expect(res.ok).toBe(true);
      const data = (res as { data?: { accepted: boolean; snapshot?: { host?: string } } }).data;
      expect(data.accepted).toBe(true);
      expect(data.snapshot?.host).toBe("resolved.example");
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("a missing ssh binary is a command failure with the binary-missing class", async () => {
    const { ctx } = setup("no-ssh", "/nonexistent/ssh-binary");
    const res = await send(ctx, { type: "ssh_test_connection", snapshot: SNAPSHOT } as NodeCommandBody);
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("binary missing");
  });
});
