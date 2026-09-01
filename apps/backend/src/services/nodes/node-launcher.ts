import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "@internal/harnesses";

/** One harness start, structured (spec 2026-08-31 §6.3). */
export interface LaunchPlan {
  /** mote session id (also the tmux session name) */
  id: string;
  /** tmux socket (tmuxSocketFor(id)) */
  socket: string;
  /** Resolved plugin */
  harness: HarnessPlugin;
  /** Absolute binary path on the TARGET machine (resolveBinary output) */
  binary: string;
  /** Working dir on the TARGET machine (validateWorkingDir output) */
  cwd: string;
  /** Decoded profile */
  profile: ProfileDefinition;
  /** Display/session name handed to the plugin */
  sessionName: string;
  /** MOTE_* credential env */
  moteEnv: Record<string, string>;
  /** MCP registration (dialect computed control-side) */
  mcp?: McpRegistration;
  /**
   * Absolute path ON THE TARGET machine where `RemoteLauncher` ships
   * `mcp.fileContent` — composed by the caller from the node's `ready.dataDir`
   * (spec §6.4). Additive phase-2 field; `LocalLauncher` ignores it, its file
   * was already written by `registerSessionMcp`.
   */
  mcpConfigPath?: string;
  /** Resume pin */
  harnessSession?: { id: string; mode: "start" | "resume" };
  /**
   * A log-attach failure (log-dir mkdir or pipe-pane) is logged and ignored
   * instead of failing the launch. Used by revive, where a live pane must
   * survive a lost replay log — restores the pre-seam semantics
   * (createSession stays strict).
   */
  bestEffortLog?: boolean;
}

/**
 * Every machine-local operation a session needs, so the orchestrator never
 * touches tmux/fs/agent sockets directly (spec §6.3). LocalLauncher is
 * today's code; RemoteLauncher (phase 2) signs NodeCommandBodies.
 *
 * Phase-2 invariants (binding on implementations AND callers):
 * - Implementations whose methods await (RemoteLauncher) MUST serialize
 *   per-node dispatch in call order — the agent's seq gate drops reordered
 *   frames, so a `terminate` that overtakes a queued `launch` is silently
 *   lost, not merely late.
 * - Callers MUST NOT overlap per-session pumps (capture loop + poll loop,
 *   two attach streams) on one session: even serialized dispatch can flip
 *   the read-your-writes order these pumps rely on between their own
 *   successive calls.
 */
export interface NodeLauncher {
  /** Validates/normalizes a requested working dir; throws if unusable. */
  validateWorkingDir(raw: string): Promise<string>;
  /** Absolute path of the harness binary on the target machine, null if absent. */
  resolveBinary(harness: HarnessPlugin): Promise<string | null>;
  /** Starts one harness from a plan; throws on failure unless plan.bestEffortLog covers a step. */
  launch(plan: LaunchPlan): Promise<void>;
  /** Strict kill of the tmux session — throws when tmux refuses (unlike {@link killSession}). */
  terminate(socket: string, id: string): Promise<void>;
  /** Raw kill of the tmux session; swallows "already gone". */
  killSession(socket: string, id: string): Promise<void>;
  /** Whether a session with that name exists on the socket. */
  hasSession(socket: string, id: string): Promise<boolean>;
  /** The dead pane's exit code, null if unavailable. */
  paneExitCode(socket: string, id: string): Promise<number | null>;
  /** Pane's OSC title plus the running command, null if the pane is gone. */
  paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null>;
  /** Snapshot of the pane's visible grid as text. */
  capture(socket: string, id: string): Promise<string>;
  /** Propagates client geometry to the pane. */
  resize(socket: string, id: string, cols: number, rows: number): Promise<void>;
  /** Types raw input into the pane (escape sequences included). */
  sendInput(socket: string, id: string, input: string): Promise<void>;
  /** Submits the pane's pending input line. */
  pressEnter(socket: string, id: string): Promise<void>;
  /**
   * Types `text` into a fresh pane once it shows output and submits it — the
   * mirror of the phase-2 `prompt_deliver` command, so a remote agent runs
   * the whole settle loop as ONE round-trip. Returns `promptDelivered`
   * (false on settle timeout or failed input; never throws).
   */
  deliverPrompt(socket: string, id: string, text: string, settleTimeoutMs: number, pollMs: number): Promise<boolean>;
  /** Absolute path of the session's pipe-pane replay log. */
  logPath(id: string): string;
  /** Tail of the replay log for the initial pane render. */
  readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }>;
  /** Byte-range read of the replay log; `next` is the offset to resume from. */
  readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }>;
  /** Starts a log-tail subscription; resolves to its cancel function. */
  tailStart(
    id: string,
    subId: string,
    fromByte: number,
    onChunk: (bytes: Uint8Array, next: number) => void,
  ): Promise<() => void>;
  /** Whether the harness can actually resume the stored session id in that cwd. */
  canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean>;
  /** Persists a per-session artifact (e.g. MCP config); returns its path on the target machine. */
  writeArtifact(id: string, kind: "mcp-config", content: string): Promise<string>;
  /** Best-effort deletion of artifact paths written by writeArtifact. */
  removeArtifacts(paths: string[]): Promise<void>;
}
