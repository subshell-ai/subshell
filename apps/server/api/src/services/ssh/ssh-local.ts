import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildSshInvocation,
  classifySshFailure,
  defaultSshConfigPath,
  discoverSshAliases,
  ensureSshDirs,
  ensureTerminalsDir,
  findBinary,
  getSshRunSupervisor,
  initTerminalForLaunch,
  remoteTerminalLine,
  renderSshConfigContents,
  resolveSshAliasConfig,
  runSshProcess,
  sshChildEnv,
  sshChildPath,
  sshTerminalEnvPairs,
  sshTerminalPaneCommand,
  TmuxRunner,
  terminalLogPath,
  transitionControl,
} from "@internal/pane-runtime";
import {
  isNodeSubshellId,
  NODE_RESULT_SSH_GENERATION_STALE,
  parseNodeSshAliasList,
  parseNodeSshControlResult,
  parseNodeSshResolveOutcome,
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
  parseNodeSshTestOutcome,
  SSH_PROBE_DEADLINE_MS,
  type SshConnectionSnapshotWire,
  type SshInputControlCommand,
  type SshNodeCommandBody,
  type SshTerminalLaunchCommand,
} from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { probePaneLogLaunch } from "@/services/mcp-resolve.js";

/**
 * The server-hosted node's SSH dispatch (SSH-SUPPORT.md §1 "An administrator
 * may configure a private connection through the server's built-in node", §3
 * "The server-hosted node uses the same runtime directly"). The built-in
 * `local` node IS this process, so an SSH verb aimed at it needs no frame and
 * no socket: it calls the SAME `@internal/pane-runtime` SSH modules the agent
 * daemon wraps in `apps/node/agent/src/commands/ssh-*.ts`, against the server's
 * own pane data dir. There is deliberately ONE implementation of every SSH
 * rule (durable dedup, the mandatory runtime policy, the probe, the terminal
 * renderer), and it is the runtime's - this module is the thin `local` twin of
 * the agent's command handlers, so the two can never drift.
 *
 * The result mirrors the agent's `CommandResult`: `{ok:true, data}` is the
 * payload a live node would answer (the caller re-validates it with the frozen
 * wire parsers exactly as it does a socket answer), and `{ok:false, error}`
 * carries the SAME strings the agent emits - the bare `SSH_ERROR_CODES`
 * spellings the plane maps by equality, and the node-result constants - so
 * `ssh-node-client` classifies a local refusal through the identical arm as a
 * remote one. Nothing here invents a wire shape.
 *
 * What is NOT duplicated on purpose: the maintenance and eligibility checks
 * (`sshNodeGate` runs them for `local` off the node row before dispatch ever
 * reaches here, exactly as it does for an agent whose link is the only place
 * that flag lives) and the input-generation fence (for `local` the machine IS
 * the plane, so `ssh_panes.control_generation` is the fence value;
 * `ssh-pane-hooks` reads it directly rather than mirroring it into a store the
 * agent keeps because the agent is a different process).
 */

/**
 * The agent's `CommandResult`, restated for the in-process twin (same field
 * names, same contract). `data` is the parsed wire payload (`SshRunFactsWire`,
 * `NodeSshAliasListResult`, ...) which the caller in `ssh-node-client`
 * re-validates and returns as the RPC result, exactly as it does a socket
 * answer's `data` - hence `unknown` here rather than a JSON re-assertion.
 */
export type LocalSshResult = { ok: true; data?: unknown } | { ok: false; error: string };

/** The ssh-binary ladder, the agent's `ssh-shared.ts` twin verbatim (app→app imports are the architecture's wall, so the known-path list is stated twice rather than one app importing the other). */
const SSH_KNOWN_PATHS = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];
const SSH_BINARY_ENV = "SUBSHELL_SSH_PATH";

/** Resolve the ssh binary on THIS machine (the server's account), or null. */
async function resolveLocalSshBin(): Promise<string | null> {
  return await findBinary("ssh", SSH_BINARY_ENV, SSH_KNOWN_PATHS);
}

/** The connecting account's home, exactly how the agent sees its own (HOME, else the OS homedir). */
function connectingHome(): string {
  return process.env.HOME || homedir();
}

/** The one tmux runner for local SSH terminal panes (lazy; a bare `new` is pure, no IO at import). */
let tmuxSingleton: TmuxRunner | null = null;
function localTmux(): TmuxRunner {
  tmuxSingleton ??= new TmuxRunner();
  return tmuxSingleton;
}

/** @internal Drop the memoized runner (a test that points the socket elsewhere). */
export function resetLocalSshTmuxForTests(): void {
  tmuxSingleton = null;
}

/**
 * Dispatch one `ssh_*` command against this process's own SSH runtime. Called
 * ONLY from `ssh-node-client` when the target node is `local`; the caller does
 * the wire-parse validation and the refusal classification, so the same
 * `parseNodeSsh*`/`isSshErrorCode` path governs local and agent answers alike.
 */
export async function dispatchLocalSsh(cmd: SshNodeCommandBody): Promise<LocalSshResult> {
  switch (cmd.type) {
    case "ssh_discover_aliases": {
      const home = connectingHome();
      const found = discoverSshAliases({ homeDir: home, configPath: defaultSshConfigPath(home) });
      const data = parseNodeSshAliasList({
        aliases: found.aliases,
        includeCycle: found.includeCycle,
        truncated: found.truncated,
      });
      return data === null ? { ok: false, error: "malformed alias discovery" } : { ok: true, data };
    }
    case "ssh_resolve_config": {
      const sshBin = await resolveLocalSshBin();
      if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
      const home = connectingHome();
      // The agent's twin: `-G` evaluation against the account's OWN config, and
      // the account's name for the §3 review card. A refusal is a SUCCESSFUL
      // answer (it rides `accepted:false` in the data); only a missing binary
      // is a command failure.
      const outcome = await resolveSshAliasConfig(cmd.alias, {
        sshBin,
        homeDir: home,
        configPath: defaultSshConfigPath(home),
      });
      const data = parseNodeSshResolveOutcome(outcome);
      return data === null ? { ok: false, error: "malformed resolve outcome" } : { ok: true, data };
    }
    case "ssh_test_connection":
      return localSshTest(cmd.snapshot);
    case "ssh_run_start": {
      if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
      const sup = await localSupervisor();
      if (sup === null) return { ok: false, error: "ssh binary missing: ssh" };
      const started = await sup.start({
        runId: cmd.runId,
        requestDigest: cmd.requestDigest,
        snapshot: cmd.snapshot,
        remoteDir: cmd.remoteDir,
        command: cmd.command,
        deadlineMs: cmd.deadlineMs,
      });
      if (started.kind === "refused") return { ok: false, error: started.code };
      const data = parseNodeSshRunFacts(started.facts);
      return data === null ? { ok: false, error: "malformed run facts" } : { ok: true, data };
    }
    case "ssh_run_status": {
      if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
      const sup = await localSupervisor();
      if (sup === null) return { ok: false, error: "ssh binary missing: ssh" };
      const facts = sup.status(cmd.runId);
      if (facts === null) return { ok: false, error: "run_unknown" };
      const data = parseNodeSshRunFacts(facts);
      return data === null ? { ok: false, error: "malformed run facts" } : { ok: true, data };
    }
    case "ssh_run_cancel": {
      if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
      const sup = await localSupervisor();
      if (sup === null) return { ok: false, error: "ssh binary missing: ssh" };
      const facts = await sup.cancel(cmd.runId);
      if (facts === null) return { ok: false, error: "run_unknown" };
      const data = parseNodeSshRunFacts(facts);
      return data === null ? { ok: false, error: "malformed run facts" } : { ok: true, data };
    }
    case "ssh_run_read": {
      if (!isNodeSubshellId(cmd.runId)) return { ok: false, error: "run_unknown" };
      const sup = await localSupervisor();
      if (sup === null) return { ok: false, error: "ssh binary missing: ssh" };
      const result = await sup.read(cmd.runId, cmd.stdoutFromByte, cmd.stderrFromByte, cmd.maxBytes, cmd.waitMs);
      if (result === null) return { ok: false, error: "run_unknown" };
      const data = parseNodeSshRunReadResult(result);
      return data === null ? { ok: false, error: "malformed run read result" } : { ok: true, data };
    }
    case "ssh_terminal_launch":
      return localSshTerminalLaunch(cmd);
    case "ssh_input_control": {
      const transition = inputControlLocal(cmd);
      if (transition.kind === "stale") return { ok: false, error: NODE_RESULT_SSH_GENERATION_STALE };
      // The fence is the PLANE row for `local` (see module doc): no separate
      // store mirrors it, and `transitionPaneControl` raises the plane row on
      // this same beat, so the machine answer is already the truth.
      const data = parseNodeSshControlResult({
        subshellId: cmd.subshellId,
        mode: transition.state.mode,
        generation: transition.state.generation,
      });
      return data === null ? { ok: false, error: "malformed control result" } : { ok: true, data };
    }
    default:
      // Not an ssh_* verb: the caller only routes the ssh family here.
      return { ok: false, error: "unsupported" };
  }
}

/** `ssh_input_control` against this machine's terminal state (the plane row is the fence; module doc). */
function inputControlLocal(cmd: SshInputControlCommand): ReturnType<typeof transitionControl> {
  if (!isNodeSubshellId(cmd.subshellId)) {
    // A malformed id composes no path; answer the stale shape (nothing moved)
    // rather than throwing, matching the agent's refusal-not-crash posture.
    return { kind: "stale", state: { mode: cmd.mode, generation: cmd.generation, logGeneration: 1 } };
  }
  return transitionControl(SUBSHELL_SERVER_DATA_DIR, cmd.subshellId, cmd.mode, cmd.generation);
}

/** The one run supervisor for the server's data dir (memoized inside pane-runtime by dataDir), or null with no ssh binary. */
async function localSupervisor() {
  const sshBin = await resolveLocalSshBin();
  if (sshBin === null) return null;
  return getSshRunSupervisor({
    dataDir: SUBSHELL_SERVER_DATA_DIR,
    homeDir: connectingHome(),
    sshBin,
    nowMs: Date.now,
  });
}

/** The `ssh_test_connection` probe: the fixed `true`, a throwaway config, the §3 30-second budget. */
async function localSshTest(snapshot: SshConnectionSnapshotWire): Promise<LocalSshResult> {
  const sshBin = await resolveLocalSshBin();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  const dataDir = SUBSHELL_SERVER_DATA_DIR;
  ensureSshDirs(dataDir);
  const probeDir = join(dataDir, "ssh", "probes");
  const dirExisted = existsSync(probeDir);
  mkdirSync(probeDir, { recursive: true });
  if (!dirExisted) chmodDir0700(probeDir);
  const configPath = join(probeDir, `${randomUUID()}.config`);
  const fd = openSync(
    configPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, renderSshConfigContents(snapshot));
  } finally {
    closeSync(fd);
  }
  try {
    const argv = buildSshInvocation({
      sshBin,
      snapshot,
      configPath,
      remoteCommand: "true", // the one probe command, not a parameter (agent twin)
    });
    const env = await sshChildEnv(snapshot, connectingHome());
    const run = await runSshProcess(argv, env, SSH_PROBE_DEADLINE_MS);
    const outcome =
      run.code === 0
        ? { passed: true }
        : {
            passed: false as const,
            code: (run.timedOut ? null : classifySshFailure(run.stderr)) ?? ("connection_failed" as const),
          };
    const data = parseNodeSshTestOutcome(outcome);
    return data === null ? { ok: false, error: "malformed test outcome" } : { ok: true, data };
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // transient by construction; the probe subtree is swept with the ssh sweep
    }
  }
}

/** The `ssh_terminal_launch` twin: the pane whose foreground process is ssh, on THIS host's tmux. */
async function localSshTerminalLaunch(cmd: SshTerminalLaunchCommand): Promise<LocalSshResult> {
  if (!isNodeSubshellId(cmd.subshellId)) return { ok: false, error: "invalid subshell id" };
  const sshBin = await resolveLocalSshBin();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  const dataDir = SUBSHELL_SERVER_DATA_DIR;
  const home = connectingHome();

  // Terminal state BEFORE the pane exists (agent twin): log generation bumped,
  // old segments cleared, control state preserved. The input-generation mirror
  // the agent records is the plane row for `local` (module doc).
  initTerminalForLaunch(dataDir, cmd.subshellId);

  ensureTerminalsDir(dataDir);
  const configPath = join(dataDir, "ssh", "terminals", `${cmd.subshellId}.config`);
  writeFreshFile(configPath, renderSshConfigContents(cmd.snapshot));

  const sshArgv = buildSshInvocation({
    sshBin,
    snapshot: cmd.snapshot,
    configPath,
    forceTty: true, // uniform remote PTY (coordinator ruling, agent twin)
  });
  const paneCmd = sshTerminalPaneCommand(
    sshTerminalEnvPairs(cmd.snapshot, home, await sshChildPath()),
    sshArgv,
    remoteTerminalLine(cmd.remoteDir),
  );

  const tmux = localTmux();
  try {
    // No exit hook and no MCP/subshell credentials in the pane (§2/§3, agent
    // twin): ssh is the foreground process and its exit ends the pane; the
    // server's own sweep owns this row's death.
    tmux.newSubshell(cmd.socket, cmd.subshellId, dataDir, paneCmd);
  } catch {
    // nothing spawned: leave no fresh config/state orphan beyond the row
    try {
      unlinkSync(configPath);
    } catch {
      // best-effort
    }
    throw new Error("local ssh terminal launch failed");
  }
  // Capture at the conventional pane-log path so tail/replay/log_read work
  // unchanged; the child is this binary's `pane-log` verb (agent twin).
  tmux.pipePane(
    cmd.socket,
    cmd.subshellId,
    terminalLogPath(dataDir, cmd.subshellId),
    probePaneLogLaunch().spec ?? undefined,
  );
  if (cmd.cols !== undefined && cmd.rows !== undefined) {
    try {
      await tmux.resizeWindow(cmd.socket, cmd.subshellId, cmd.cols, cmd.rows);
    } catch {
      // cosmetic, continuing (agent twin)
    }
  }
  return { ok: true };
}

function writeFreshFile(path: string, content: string): void {
  try {
    unlinkSync(path);
  } catch {
    // nothing there
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** mkdir's mode is umask-masked: re-tighten a freshly created dir to 0700 (the codebase-wide discipline). */
function chmodDir0700(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort; the probe files inside are the sensitive half
  }
}
