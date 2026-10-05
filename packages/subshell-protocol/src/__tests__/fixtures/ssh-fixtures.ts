/**
 * Shared SSH fixtures (Gate A). Workstreams B, C, D and G build their suites
 * from THESE factories rather than hand-rolling frames: a fixture that stops
 * parsing is a contract break caught in the protocol package, not four silent
 * drifts downstream. Every factory returns the WIRE type (plain data), every
 * "boundary" export is the exact legal extreme, and `invalidSnapshotVariants`
 * is the adversarial set the node-side validator must refuse - one member per
 * absent-forbidden field plus the hygiene refusals.
 *
 * Pure data + spread overrides; imports nothing from `bun:test` so production
 * code could (but should not) share it.
 */

import type { SshConnectionSnapshotWire, SshHopWire } from "../../ssh-config.js";
import type { SshErrorCode } from "../../ssh-errors.js";
import type {
  SshDiscoverAliasesCommand,
  SshInputControlCommand,
  SshResolveConfigCommand,
  SshRunCancelCommand,
  SshRunReadCommand,
  SshRunStartCommand,
  SshRunStatusCommand,
  SshTerminalLaunchCommand,
  SshTestConnectionCommand,
} from "../../ssh-frames.js";
import {
  SSH_COMMAND_MAX_CHARS,
  SSH_MAX_IDENTITY_REFS,
  SSH_MAX_PROXY_HOPS,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_DEADLINE_MAX_MS,
} from "../../ssh-limits.js";
import type {
  NodeSshAliasListResult,
  NodeSshControlResult,
  NodeSshResolveOutcomeWire,
  NodeSshRunReadResult,
  NodeSshTestOutcomeWire,
} from "../../ssh-results.js";
import type { SshRunFactsWire } from "../../ssh-run-facts.js";

/** A well-formed hop (fixture arg for chains). */
export function makeHop(n = 0): SshHopWire {
  return { host: `jump-${n}.example.net`, user: n % 2 === 0 ? `jumpuser${n}` : null, port: 22 };
}

/** The canonical approved snapshot: two identities, an agent, two known-hosts files, one hop. */
export function makeSnapshot(overrides: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "app02",
    host: "app-02.example.net",
    user: "deploy",
    port: 22,
    identityFiles: ["/home/deploy/.ssh/id_ed25519", "/home/deploy/.ssh/deploy_key"],
    certificateFiles: ["/home/deploy/.ssh/id_ed25519-cert.pub"],
    authAgentSocket: "/run/user/1000/ssh-agent.sock",
    knownHostsFiles: ["/home/deploy/.ssh/known_hosts", "/etc/ssh/ssh_known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [makeHop(0)],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
    ...overrides,
  };
}

/**
 * An invalid snapshot per forbidden field, with a realistic offending value.
 * The node validator must refuse EVERY entry here, and the resolve/UI story
 * must be able to name which field blocked.
 */
export function invalidSnapshotVariants(): { field: string; snapshot: Record<string, unknown> }[] {
  const base = makeSnapshot();
  return [
    { field: "proxyCommand", snapshot: { ...base, proxyCommand: "nc proxy 8443" } },
    { field: "forwards", snapshot: { ...base, forwards: "LocalForward 9000 socks" } },
    { field: "tunnels", snapshot: { ...base, tunnels: "yes" } },
    { field: "localCommands", snapshot: { ...base, localCommands: "notify-send up" } },
    { field: "remoteCommand", snapshot: { ...base, remoteCommand: "sh -i" } },
    { field: "sendEnv", snapshot: { ...base, sendEnv: "LANG LC_*" } },
    { field: "setEnv", snapshot: { ...base, setEnv: "FOO=bar" } },
    { field: "escapes", snapshot: { ...base, escapes: "~C" } },
  ];
}

/** Hygiene violations the snapshot parser must refuse (beyond the forbidden members). */
export function invalidSnapshotHygieneVariants(): { field: string; snapshot: Record<string, unknown> }[] {
  const base = makeSnapshot();
  return [
    { field: "optionLikeHost", snapshot: { ...base, host: "-oProxyCommand=touch_pwned" } },
    { field: "controlCharUser", snapshot: { ...base, user: "deploy\x00" } },
    { field: "relativeIdentity", snapshot: { ...base, identityFiles: [".ssh/id_ed25519"] } },
    { field: "zeroPort", snapshot: { ...base, port: 0 } },
    {
      field: "overMaxHops",
      snapshot: { ...base, proxyJumps: Array.from({ length: SSH_MAX_PROXY_HOPS + 1 }, (_, i) => makeHop(i)) },
    },
    {
      field: "identityListTooLong",
      snapshot: {
        ...base,
        identityFiles: Array.from({ length: SSH_MAX_IDENTITY_REFS + 1 }, (_, i) => `/home/deploy/.ssh/id_${i}`),
      },
    },
    { field: "missingUserKey", snapshot: Object.fromEntries(Object.entries(base).filter(([k]) => k !== "user")) },
  ];
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/** The one input-free command, spelled for census loops. */
export function makeDiscoverAliases(): SshDiscoverAliasesCommand {
  return { type: "ssh_discover_aliases" };
}

export function makeResolveConfig(overrides: Partial<SshResolveConfigCommand> = {}): SshResolveConfigCommand {
  return { type: "ssh_resolve_config", alias: "app02", ...overrides };
}

export function makeTestConnection(overrides: Partial<SshTestConnectionCommand> = {}): SshTestConnectionCommand {
  return { type: "ssh_test_connection", snapshot: makeSnapshot(), ...overrides };
}

/** A start at the legal defaults; override `deadlineMs`/`command` for boundary tests. */
export function makeRunStart(overrides: Partial<SshRunStartCommand> = {}): SshRunStartCommand {
  return {
    type: "ssh_run_start",
    runId: "5b8f1c4e-9a7d-4c6e-8f2b-1d0e9c8b7a6f",
    snapshot: makeSnapshot(),
    remoteDir: "/srv/app",
    command: "systemctl status app --no-pager",
    deadlineMs: 300_000,
    requestDigest: "a".repeat(64),
    ...overrides,
  };
}

/** Start at every parser boundary at once: max deadline, max-length command, null dir, one-char command variants are separate factories. */
export function makeRunStartAtLimits(): SshRunStartCommand {
  return makeRunStart({ deadlineMs: SSH_RUN_DEADLINE_MAX_MS, command: "x".repeat(SSH_COMMAND_MAX_CHARS) });
}

/** The minimum-legal start: no directory, one-char command, one-ms deadline. */
export function makeRunStartMinimum(): SshRunStartCommand {
  return makeRunStart({ remoteDir: null, command: "t", deadlineMs: 1 });
}

export function makeRunStatus(runId = "5b8f1c4e-9a7d-4c6e-8f2b-1d0e9c8b7a6f"): SshRunStatusCommand {
  return { type: "ssh_run_status", runId };
}

export function makeRunCancel(runId = "5b8f1c4e-9a7d-4c6e-8f2b-1d0e9c8b7a6f"): SshRunCancelCommand {
  return { type: "ssh_run_cancel", runId };
}

/** A read at the wire caps: full window, full long-poll budget, zeroed offsets. */
export function makeRunRead(overrides: Partial<SshRunReadCommand> = {}): SshRunReadCommand {
  return {
    type: "ssh_run_read",
    runId: "5b8f1c4e-9a7d-4c6e-8f2b-1d0e9c8b7a6f",
    stdoutFromByte: 0,
    stderrFromByte: 0,
    maxBytes: SSH_OUTPUT_WINDOW_MAX_BYTES,
    waitMs: SSH_READ_LONG_POLL_MAX_MS,
    ...overrides,
  };
}

/** A terminal launch with an explicit grid. */
export function makeTerminalLaunch(overrides: Partial<SshTerminalLaunchCommand> = {}): SshTerminalLaunchCommand {
  return {
    type: "ssh_terminal_launch",
    subshellId: "7c2e9d1a-4b8f-4e6c-9d0a-2b1c8e7f6a5d",
    socket: "subshell-7c2e9d1a",
    snapshot: makeSnapshot(),
    remoteDir: null,
    cols: 120,
    rows: 40,
    ...overrides,
  };
}

export function makeInputControl(overrides: Partial<SshInputControlCommand> = {}): SshInputControlCommand {
  return {
    type: "ssh_input_control",
    subshellId: "7c2e9d1a-4b8f-4e6c-9d0a-2b1c8e7f6a5d",
    mode: "human",
    generation: 2,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

/** Completed, confirmed facts: the ordinary happy end. */
export function makeRunFacts(overrides: Partial<SshRunFactsWire> = {}): SshRunFactsWire {
  return {
    runId: "5b8f1c4e-9a7d-4c6e-8f2b-1d0e9c8b7a6f",
    lifecycle: "completed",
    cancelRequested: false,
    cancelLocalConfirmed: false,
    deadlineHit: false,
    remoteStatus: 0,
    remoteStatusConfirmed: true,
    localExitCode: 0,
    localExitSignal: null,
    ...overrides,
  };
}

/**
 * The 255 case: transport-ambiguous, never assertable as a confirmed remote
 * result. Suites pin that nobody's reducer upgrades it.
 */
export function makeRunFactsAmbiguous255(): SshRunFactsWire {
  return makeRunFacts({
    lifecycle: "unknown",
    remoteStatus: 255,
    remoteStatusConfirmed: false,
    localExitCode: 255,
  });
}

/** Freshly accepted, nothing observed yet. */
export function makeRunFactsAccepted(): SshRunFactsWire {
  return makeRunFacts({
    lifecycle: "accepted",
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
  });
}

/** Cancelled with a dead local ssh, remote descendants unconfirmed. */
export function makeRunFactsCancelled(): SshRunFactsWire {
  return makeRunFacts({
    lifecycle: "completed",
    cancelRequested: true,
    cancelLocalConfirmed: true,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: "SIGTERM",
  });
}

/** A run that hit its deadline; supervision killed the local side. */
export function makeRunFactsDeadlineHit(): SshRunFactsWire {
  return makeRunFacts({
    lifecycle: "unknown",
    deadlineHit: true,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: "SIGKILL",
  });
}

/** Empty read window riding the accepted facts. */
export function makeRunReadResult(overrides: Partial<NodeSshRunReadResult> = {}): NodeSshRunReadResult {
  return {
    ...makeRunFactsAccepted(),
    stdoutB64: "",
    stderrB64: "",
    stdoutNext: 0,
    stderrNext: 0,
    stdoutTotal: 0,
    stderrTotal: 0,
    truncated: false,
    ...overrides,
  };
}

/** A running read carrying "hi\n"/"oh\n" (b64 of the two payloads). */
export function makeRunReadResultWithData(): NodeSshRunReadResult {
  return makeRunReadResult({
    lifecycle: "running",
    // btoa("hi\n") === "aGkK" and btoa("oh\n") === "b2gK", verified by test:
    // the fixtures carry REAL base64 because the validators check the alphabet.
    stdoutB64: "aGkK",
    stderrB64: "b2gK",
    stdoutNext: 3,
    stderrNext: 3,
    stdoutTotal: 3,
    stderrTotal: 3,
  });
}

export function makeAliasList(overrides: Partial<NodeSshAliasListResult> = {}): NodeSshAliasListResult {
  return { aliases: ["app01", "app02", "staging"], includeCycle: false, truncated: false, ...overrides };
}

export function makeResolveOk(snapshot = makeSnapshot()): NodeSshResolveOutcomeWire {
  return { accepted: true, snapshot };
}

export function makeResolveRefused(
  code: SshErrorCode = "unsupported_setting",
  settings = ["ProxyCommand"],
): NodeSshResolveOutcomeWire {
  return { accepted: false, code, settings };
}

export function makeTestPassed(): NodeSshTestOutcomeWire {
  return { passed: true };
}

export function makeTestFailed(code: SshErrorCode = "host_key_unknown"): NodeSshTestOutcomeWire {
  return { passed: false, code };
}

export function makeControlResult(overrides: Partial<NodeSshControlResult> = {}): NodeSshControlResult {
  return {
    subshellId: "7c2e9d1a-4b8f-4e6c-9d0a-2b1c8e7f6a5d",
    mode: "human",
    generation: 2,
    ...overrides,
  };
}
