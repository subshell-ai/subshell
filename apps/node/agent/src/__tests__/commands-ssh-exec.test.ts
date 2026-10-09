import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAgentSocketPath,
  buildSshConfigPath,
  buildSshKnownHostsPath,
  type SshProcessResult,
} from "@internal/pane-runtime";
import { NODE_RESULT_MAINTENANCE, type SshExecCommand, type SshExecStatusCommand } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execSshExec, execSshExecStatus, resetSshExecRunsForTests, type SshExecSeams } from "../commands/ssh-exec.js";
import { writeMaintenance } from "../maintenance.js";
import { writeSshEnabled } from "../ssh-enabled.js";
import { isSubshellId } from "../subshell-meta.js";

/**
 * The `ssh_exec` non-interactive setup run (spec 2026-10-08 §7, Task 14): the
 * "Set up Subshell here" act's separate short-lived `ssh D '<install>'` on B,
 * with the `nsk_` redactor standing between the installer's output and every
 * surface that outlives the command. Posture copied from the sibling ssh
 * arms: the gate speaks first, the config path is byte-checked against THIS
 * machine's own derivation (the launch-frame doctrine restated for the exec),
 * the run is off the command chain (an installer takes minutes; the chain
 * must stay free), and the status answer carries only redacted, tail-truncated
 * output. The runProcess seam replaces the real ssh child; this file owns the
 * arm's decisions, not OpenSSH's behavior.
 */

const STAMP = "2026-10-08T10:00:00.000Z";
const GATE_REFUSAL = "ssh disabled on this node";
const EXEC_ID = "11111111-2222-4333-8444-555555555555";
const KEY = "nsk_LYr6F2g63jWYpSF1g9MWZaqx6V9HDGJi";

let base: string;
let savedSshPath: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-exec-")));
  savedSshPath = process.env.SUBSHELL_SSH_PATH;
  // A stub ssh so the REAL runSshProcess cases can spawn something real.
  const stub = join(base, "ssh-stub.sh");
  writeFileSync(stub, "#!/bin/sh\necho '==> done.'\n", { mode: 0o755 });
  resetSshExecRunsForTests();
});

afterAll(() => {
  if (savedSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
  else process.env.SUBSHELL_SSH_PATH = savedSshPath;
  resetSshExecRunsForTests();
  rmSync(base, { recursive: true, force: true });
});

// The exec registry is module state (one daemon, one map); tests share the
// EXEC_ID, so each one starts from an empty map.
beforeEach(() => resetSshExecRunsForTests());

function makeCtx(tag: string, opts: { gateOn?: boolean; maintenanceOn?: boolean } = {}): CommandContext {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  if (opts.gateOn !== false) writeSshEnabled(dir, { on: true, changedAt: STAMP });
  if (opts.maintenanceOn) writeMaintenance(dir, { on: true, changedAt: STAMP });
  return { config: { dataDir: dir }, nowMs: () => Date.now() } as unknown as CommandContext;
}

function execCmd(dir: string, over: Partial<SshExecCommand> = {}): SshExecCommand {
  return {
    type: "ssh_exec",
    execId: EXEC_ID,
    configPath: buildSshConfigPath(dir, EXEC_ID),
    fileContent: "Host *\n  StrictHostKeyChecking yes\n",
    presetFlags: ["-o", "BatchMode=yes", "-F", buildSshConfigPath(dir, EXEC_ID), "--", "d.example.test"],
    command: `curl -fsSL "http://plane.test/install.sh?setup_key=${KEY}" | SUBSHELL_NODE_NAME="d" bash`,
    relay: true,
    agentSocketPath: null,
    timeoutMs: 600_000,
    ...over,
  };
}

function statusCmd(execId = EXEC_ID): SshExecStatusCommand {
  return { type: "ssh_exec_status", execId };
}

/** Bind the relay proxy socket path the way openBRelaySession left it (a file at the derived path). */
function bindSocket(dir: string): string {
  const path = buildAgentSocketPath(dir, EXEC_ID);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "stub");
  return path;
}

/** A runProcess seam that answers a canned result and records the argv + env it was handed. */
function fakeRun(
  result: Partial<SshProcessResult>,
  opts: { defer?: boolean } = {},
): {
  seams: SshExecSeams;
  calls: { argv: readonly string[]; env: Record<string, string>; timeoutMs: number }[];
  finish: (r?: Partial<SshProcessResult>) => void;
} {
  const calls: { argv: readonly string[]; env: Record<string, string>; timeoutMs: number }[] = [];
  let settle: ((r: SshProcessResult) => void) | null = null;
  const seams: SshExecSeams = {
    resolveSshBin: async () => "/usr/bin/fake-ssh",
    runProcess: ((argv, env, timeoutMs) => {
      calls.push({ argv, env, timeoutMs });
      const full: SshProcessResult = { code: 0, stdout: "", stderr: "", timedOut: false, spawnError: false, ...result };
      if (opts.defer) {
        return new Promise<SshProcessResult>((resolve) => {
          settle = (r) => resolve({ ...full, ...r });
        });
      }
      return Promise.resolve(full);
    }) as unknown as SshExecSeams["runProcess"],
  };
  return { seams, calls, finish: (r) => settle?.(r ?? {}) };
}

describe("ssh_exec gate and path discipline", () => {
  it("the gate speaks first: a mirror not ON refuses before any spawn", async () => {
    const ctx = makeCtx("gate-off", { gateOn: false });
    const { seams, calls } = fakeRun({});
    const res = await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
    expect(calls).toHaveLength(0);
  });

  it("maintenance refuses the run (the machine is out of service for new work)", async () => {
    const ctx = makeCtx("maint", { maintenanceOn: true });
    const { seams, calls } = fakeRun({});
    const res = await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    expect(res).toEqual({ ok: false, error: NODE_RESULT_MAINTENANCE });
    expect(calls).toHaveLength(0);
  });

  it("refuses a config path that is not this machine's own derivation, and writes nothing", async () => {
    const ctx = makeCtx("path");
    const hostile = execCmd(ctx.config.dataDir, { configPath: "/home/u/.ssh/config" });
    const { seams, calls } = fakeRun({});
    expect(await execSshExec(ctx, hostile, seams)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    expect(existsSync(buildSshConfigPath(ctx.config.dataDir, EXEC_ID))).toBe(false);
  });

  it("refuses an exec id outside the path-composition guard", async () => {
    const ctx = makeCtx("babadid");
    const bad = execCmd(ctx.config.dataDir, { execId: "not an id" });
    expect(isSubshellId(bad.execId)).toBe(false);
    const { seams } = fakeRun({});
    expect(await execSshExec(ctx, bad, seams)).toMatchObject({ ok: false });
  });

  it("relay mode refuses when the proxy socket is not bound (no half-running the install)", async () => {
    const ctx = makeCtx("no-sock");
    const { seams, calls } = fakeRun({});
    expect(await execSshExec(ctx, execCmd(ctx.config.dataDir), seams)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("refuses when this machine has no ssh binary", async () => {
    const ctx = makeCtx("nobin");
    bindSocket(ctx.config.dataDir);
    const seams: SshExecSeams = { resolveSshBin: async () => null };
    expect(await execSshExec(ctx, execCmd(ctx.config.dataDir), seams)).toMatchObject({
      ok: false,
      error: "ssh binary missing: ssh",
    });
  });
});

describe("ssh_exec kick + status", () => {
  it("writes the config at the derived path, spawns ssh off-chain, and reports running then done", async () => {
    const ctx = makeCtx("happy");
    const socket = bindSocket(ctx.config.dataDir);
    // The relay-open also wrote the pinned known_hosts; the exec's cleanup must remove it too.
    writeFileSync(buildSshKnownHostsPath(ctx.config.dataDir, EXEC_ID), "d.example.test ssh-ed25519 AAAA\n", {
      mode: 0o600,
    });
    const { seams, calls, finish } = fakeRun({}, { defer: true });
    const kick = await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    expect(kick).toEqual({ ok: true, data: { started: true, execId: EXEC_ID } });

    const configPath = buildSshConfigPath(ctx.config.dataDir, EXEC_ID);
    expect(existsSync(configPath)).toBe(true);
    // 0600 in a 0700 dir, the launch ssh-member rule (umask cannot leak past enforceMode).
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    // One argv element for the command: ssh joins operands itself.
    expect(calls[0]?.argv).toEqual([
      "/usr/bin/fake-ssh",
      ...execCmd(ctx.config.dataDir).presetFlags,
      execCmd(ctx.config.dataDir).command,
    ]);
    expect(calls[0]?.env.SSH_AUTH_SOCK).toBe(socket); // derived, never claimed
    expect(calls[0]?.timeoutMs).toBe(600_000);

    // The run is OFF the chain: the status arm answers while ssh is still out there.
    const dup = await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    expect(dup).toMatchObject({ ok: false });
    expect(await execSshExecStatus(ctx, statusCmd(), seams)).toEqual({ ok: true, data: { state: "running" } });

    finish({ code: 0, stdout: "==> downloading subshell\n==> done.\n", stderr: "" });
    await new Promise((r) => setTimeout(r, 5)); // let the off-chain completion land
    expect(await execSshExecStatus(ctx, statusCmd(), seams)).toEqual({
      ok: true,
      data: { state: "done", code: 0, timedOut: false, stdout: "==> downloading subshell\n==> done.\n", stderr: "" },
    });
    // The per-act files are gone; the dir itself is the hourly sweep's garbage.
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(buildSshKnownHostsPath(ctx.config.dataDir, EXEC_ID))).toBe(false);
  });

  it("a captured nsk_ line NEVER survives into the status answer", async () => {
    const ctx = makeCtx("redact");
    bindSocket(ctx.config.dataDir);
    const leaky = [
      "==> downloading subshell (linux-x64) from http://plane.test",
      `curl: (22) The requested URL returned error: 404 with ${KEY} in hand`,
      `KEY="${KEY}"`,
      "subshell: setup ran with the key",
      "==> done.",
    ].join("\n");
    const { seams } = fakeRun({ code: 0, stdout: leaky, stderr: leaky });
    const kick = await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    expect(kick.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const status = await execSshExecStatus(ctx, statusCmd(), seams);
    expect(status.ok).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("nsk_");
    expect(serialized).not.toContain(KEY);
  });

  it("redaction runs BEFORE the tail truncation: a leaking line ahead of the tail cannot be cut into a survivor", async () => {
    const ctx = makeCtx("redact-tail");
    bindSocket(ctx.config.dataDir);
    const filler = Array.from({ length: 4000 }, (_, i) => `filler line ${i}`).join("\n");
    const stdout = `setup_key=${KEY} at the head\n${filler}\n==> done.`;
    const { seams } = fakeRun({ code: 0, stdout, stderr: "" });
    await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    await new Promise((r) => setTimeout(r, 5));
    const status = await execSshExecStatus(ctx, statusCmd(), seams);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("nsk_");
    expect(serialized).toContain("==> done.");
  });

  it("the deadline is reported honestly: timedOut true, code null", async () => {
    const ctx = makeCtx("timeout");
    bindSocket(ctx.config.dataDir);
    const { seams } = fakeRun({ code: null, timedOut: true, stdout: "", stderr: "killed" });
    await execSshExec(ctx, execCmd(ctx.config.dataDir), seams);
    await new Promise((r) => setTimeout(r, 5));
    expect(await execSshExecStatus(ctx, statusCmd(), seams)).toEqual({
      ok: true,
      data: { state: "done", code: null, timedOut: true, stdout: "", stderr: "killed" },
    });
  });

  it("direct mode: no socket claim means no SSH_AUTH_SOCK; the snapshot's socket rides when named", async () => {
    const ctx = makeCtx("direct");
    const named = fakeRun({});
    await execSshExec(
      ctx,
      execCmd(ctx.config.dataDir, { relay: false, agentSocketPath: "/run/user/501/ssh-agent.sock" }),
      named.seams,
    );
    expect(named.calls[0]?.env.SSH_AUTH_SOCK).toBe("/run/user/501/ssh-agent.sock");
    resetSshExecRunsForTests();
    const bare = fakeRun({});
    await execSshExec(ctx, execCmd(ctx.config.dataDir, { relay: false, agentSocketPath: null }), bare.seams);
    expect("SSH_AUTH_SOCK" in (bare.calls[0]?.env ?? {})).toBe(false);
  });

  it("status refuses an unknown exec id", async () => {
    const ctx = makeCtx("unknown");
    expect(
      await execSshExecStatus(ctx, statusCmd(), {
        resolveSshBin: async () => "/usr/bin/fake-ssh",
      }),
    ).toMatchObject({ ok: false });
  });

  it("dispatch routes both arms", async () => {
    const ctx = makeCtx("dispatch");
    bindSocket(ctx.config.dataDir);
    // The dispatch path runs the REAL binary lookup and spawn; point the
    // ladder at a stub ssh that prints the success verb and exits.
    process.env.SUBSHELL_SSH_PATH = join(base, "ssh-stub.sh");
    const kick = await dispatchCommand(ctx, execCmd(ctx.config.dataDir) as never);
    expect(kick.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const st = await dispatchCommand(ctx, statusCmd() as never);
    expect(st).toEqual({
      ok: true,
      data: { state: "done", code: 0, timedOut: false, stdout: "==> done.\n", stderr: "" },
    });
    delete process.env.SUBSHELL_SSH_PATH;
  });
});
