import type { SshRunFactsWire } from "@internal/subshell-protocol";

/**
 * Shared fixtures for the `/api/ssh` route suites: the approved-snapshot
 * builder (the grammar accepts it verbatim; `over` bends one member for the
 * refusal cases) and the run-facts answer builders the scripted node uses.
 * Suites stay readable because the 17-field snapshot is the contract, not
 * the story of any one test.
 */

export const SNAPSHOT = {
  alias: "staging",
  host: "app-02.example.net",
  user: "deploy",
  port: 22,
  identityFiles: ["/home/deploy/.ssh/id_ed25519"],
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

/** A copy of the approved snapshot with one member bent (refusal tests). */
export function snapshotWith(over: Record<string, unknown>): Record<string, unknown> {
  return { ...SNAPSHOT, ...over };
}

export function facts(over: Partial<SshRunFactsWire> & { runId: string }): SshRunFactsWire {
  return {
    lifecycle: "running",
    cancelRequested: false,
    cancelLocalConfirmed: false,
    deadlineHit: false,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: null,
    ...over,
  };
}

/** An `ssh_run_read` answer: the facts envelope plus a stdout-only window. */
export function readResult(
  runId: string,
  over: {
    stdoutB64?: string;
    stdoutNext?: number;
    stdoutTotal?: number;
    truncated?: boolean;
    lifecycle?: SshRunFactsWire["lifecycle"];
    remoteStatus?: number | null;
    remoteStatusConfirmed?: boolean;
    localExitCode?: number | null;
  } = {},
): Record<string, unknown> {
  const stdoutB64 = over.stdoutB64 ?? "";
  const stdoutNext = over.stdoutNext ?? Buffer.from(stdoutB64, "base64").length;
  return {
    ...facts({
      runId,
      lifecycle: over.lifecycle ?? "running",
      remoteStatus: over.remoteStatus ?? null,
      remoteStatusConfirmed: over.remoteStatusConfirmed ?? false,
      localExitCode: over.localExitCode ?? null,
    }),
    stdoutB64,
    stderrB64: "",
    stdoutNext,
    stderrNext: 0,
    stdoutTotal: over.stdoutTotal ?? stdoutNext,
    stderrTotal: 0,
    truncated: over.truncated ?? false,
  };
}
