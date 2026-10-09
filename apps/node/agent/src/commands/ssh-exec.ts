import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildAgentSocketPath,
  buildSshConfigPath,
  buildSshKnownHostsPath,
  enforceMode,
  runSshProcess,
  type SshProcessResult,
  sshChildPath,
} from "@internal/pane-runtime";
import {
  NODE_RESULT_MAINTENANCE,
  redactSshSetupKeyLines,
  SSH_EXEC_RETAIN_BYTES,
  type SshExecCommand,
  type SshExecStatusCommand,
} from "@internal/subshell-protocol";
import { readMaintenance } from "../maintenance.js";
import { pathAllowed, realpathRoots } from "../path-policy.js";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import { isSubshellId } from "../subshell-meta.js";
import type { CommandContext, CommandResult } from "./context.js";
import { resolveSshBin, SSH_GATE_REFUSAL } from "./ssh-shared.js";

/**
 * The `ssh_exec` non-interactive run (spec 2026-10-08 §7, Task 14): the
 * "Set up Subshell here" act's SEPARATE short-lived `ssh D '<install>'` on
 * this machine - never typed into the interactive pane, so the minted setup
 * key in the command string reaches neither the pane screen nor the pane log.
 * The rules, each load-bearing:
 *
 * - **The gate and maintenance speak first**, like every SSH arm and the
 *   launch: a mirror not ON refuses {@link SSH_GATE_REFUSAL} before any
 *   lookup or spawn, and a machine out of service takes no new work.
 * - **The config path is byte-checked against this machine's own
 *   derivation** (the launch frame's ssh-member doctrine restated): the exec
 *   id names `<dataDir>/ssh/<execId>/`, and a frame claiming any other path
 *   is refused, so a signed command can never become an arbitrary write.
 * - **Relay mode authenticates through the socket `ssh_relay_open` bound at
 *   this same derived path** - derived HERE, claimed by nothing on the wire;
 *   a kick whose proxy socket is not bound is refused rather than run with
 *   half its authentication.
 * - **The run is OFF the command chain.** An installer downloads a ~100 MB
 *   binary; the serial chain that orders every other command must stay free
 *   for the pane's own machine, so the kick acks `started` immediately and
 *   the outcome is polled with `ssh_exec_status`.
 * - **The `nsk_` redactor stands before anything is kept.** Every captured
 *   line carrying the setup-key marker is dropped BEFORE the answer-side
 *   truncation (line-wise first, tail second - a cut must never leave the
 *   key's tail bytes behind), and the per-act files (config, pinned
 *   `known_hosts`) are unlinked when the child finishes. The durable record
 *   of the act is the plane's audit, which names ids and stages only.
 *
 * State is the module's own map keyed by the (plane-minted, path-guarded)
 * exec id, TTL-swept at every touch: a done result is kept long enough for
 * the plane's poll, and a daemon that restarts forgets the act (the plane's
 * poll then names the failure; a stale entry can never outlive the sweep).
 */

/** How long a DONE exec answer is kept for the plane's poll (a running child is never swept). */
const EXEC_RESULT_TTL_MS = 30 * 60_000;

interface ExecEntry {
  startedAt: number;
  done?: { code: number | null; timedOut: boolean; stdout: string; stderr: string };
}

const runs = new Map<string, ExecEntry>();

/** Drop every expired done-entry (running children are kept whatever their age). */
function sweepRuns(nowMs: number): void {
  for (const [id, e] of runs) {
    if (e.done !== undefined && e.startedAt <= nowMs - EXEC_RESULT_TTL_MS) runs.delete(id);
  }
}

/**
 * Forget every tracked exec (daemon-test isolation).
 * @internal test-only
 */
export function resetSshExecRunsForTests(): void {
  runs.clear();
}

/** Test seams (production omits all three; the contract mirrors `HostKeySeams`). */
export interface SshExecSeams {
  /** Where ssh is; defaults to this machine's own lookup ladder. */
  resolveSshBin?: () => Promise<string | null>;
  /** One ssh run; defaults to {@link runSshProcess}. Absolute argv[0], full child env, deadline. */
  runProcess?: typeof runSshProcess;
  /** Epoch clock for the result TTL (defaults to Date.now). */
  nowMs?: () => number;
}

/** Redact per line, THEN keep the tail: the order is the leak rule (module doc). */
function retained(stream: string): string {
  const clean = redactSshSetupKeyLines(stream);
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= SSH_EXEC_RETAIN_BYTES) return clean;
  const tail = bytes.subarray(bytes.byteLength - SSH_EXEC_RETAIN_BYTES);
  // Drop a leading partial codepoint the byte cut may have produced.
  return new TextDecoder("utf-8", { fatal: false }).decode(tail);
}

/** Execute `ssh_exec`: gate, byte-check, bind, spawn off-chain, ack. */
export async function execSshExec(
  ctx: CommandContext,
  cmd: SshExecCommand,
  seams?: SshExecSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  const maintenance = readMaintenance(ctx.config.dataDir);
  if (maintenance.kind === "unreadable" || (maintenance.kind === "state" && maintenance.state.on)) {
    return { ok: false, error: NODE_RESULT_MAINTENANCE };
  }
  // The path guard is this machine's own id rule (hex+hyphen, ≤64): every fs
  // path below interpolates the exec id, so nothing past this line runs on an
  // id the composition guards could not have produced.
  if (!isSubshellId(cmd.execId)) return { ok: false, error: "invalid exec id" };
  const derivedConfig = buildSshConfigPath(ctx.config.dataDir, cmd.execId);
  if (cmd.configPath !== derivedConfig) {
    return { ok: false, error: "ssh config path refused: not the derived path" };
  }
  if (!(await pathAllowed(derivedConfig, await realpathRoots([ctx.config.dataDir])))) {
    return { ok: false, error: "ssh config path refused" };
  }
  // Relay mode: the proxy socket lives at THIS machine's derivation of the
  // same (dataDir, execId) pair the relay-open bound. No claim is read; the
  // fact is checked. An unbound socket means no signing path to D - refuse
  // loudly rather than run the install down a road that stops at auth.
  const agentSocket = cmd.relay ? buildAgentSocketPath(ctx.config.dataDir, cmd.execId) : null;
  if (agentSocket !== null && !existsSync(agentSocket)) {
    return { ok: false, error: "relay agent socket is not bound on this machine" };
  }
  const now = seams?.nowMs ?? Date.now;
  sweepRuns(now());
  if (runs.has(cmd.execId)) return { ok: false, error: "an exec with this id is already tracked" };
  const sshBin = await (seams?.resolveSshBin ?? resolveSshBin)();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };

  // Place the config like the launch arm does: own dir at 0700, file at 0600,
  // enforceMode after both (a umask can only clear bits, never past this).
  const dir = dirname(derivedConfig);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await enforceMode(dir, 0o700);
  await writeFile(derivedConfig, cmd.fileContent, { mode: 0o600 });
  await enforceMode(derivedConfig, 0o600);

  // The scoped agent env, one key, for the ssh invocation only (never a
  // whole-env inheritance - runSshProcess takes the COMPLETE child env).
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    PATH: await sshChildPath(),
  };
  if (agentSocket !== null) env.SSH_AUTH_SOCK = agentSocket;
  else if (cmd.agentSocketPath !== null) env.SSH_AUTH_SOCK = cmd.agentSocketPath;

  const entry: ExecEntry = { startedAt: now() };
  runs.set(cmd.execId, entry);
  // OFF the chain by construction: the run's promise is carried, never
  // awaited; the finish handler redacts, retains, stores, and sweeps files.
  void (seams?.runProcess ?? runSshProcess)([sshBin, ...cmd.presetFlags, cmd.command], env, cmd.timeoutMs).then(
    (r: SshProcessResult) => {
      entry.done = {
        code: r.spawnError ? null : r.code,
        timedOut: r.timedOut,
        stdout: retained(r.stdout),
        stderr: retained(r.stderr),
      };
      // The act's own files leave with the act; the dir joins the hourly
      // orphan sweep (`ssh-dir-retention`), which owns every leftover name.
      void rm(derivedConfig, { force: true }).catch(() => {});
      void rm(buildSshKnownHostsPath(ctx.config.dataDir, cmd.execId), { force: true }).catch(() => {});
    },
    () => {
      // runSshProcess never rejects today; the shape is the guard, so a
      // future throw cannot strand the entry as "running" forever.
      entry.done = { code: null, timedOut: false, stdout: "", stderr: "the ssh process could not be tracked" };
    },
  );
  return { ok: true, data: { started: true, execId: cmd.execId } };
}

/** Execute `ssh_exec_status`: the polled state of one kicked run. */
export async function execSshExecStatus(
  ctx: CommandContext,
  cmd: SshExecStatusCommand,
  seams?: SshExecSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  if (!isSubshellId(cmd.execId)) return { ok: false, error: "invalid exec id" };
  sweepRuns((seams?.nowMs ?? Date.now)());
  const e = runs.get(cmd.execId);
  if (e === undefined) return { ok: false, error: "no exec with this id on this machine" };
  if (e.done === undefined) return { ok: true, data: { state: "running" } };
  return { ok: true, data: { state: "done", ...e.done } };
}
