import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "@internal/harnesses";

/** One harness start, structured (spec 2026-08-31 §6.3). */
export interface LaunchPlan {
  /** subshell id (also the tmux session name) */
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
  /** Display/subshell name handed to the plugin */
  subshellName: string;
  /** SUBSHELL_* credential env */
  subshellEnv: Record<string, string>;
  /** MCP registration (dialect computed control-side) */
  mcp?: McpRegistration;
  /**
   * Absolute path ON THE TARGET machine where `RemoteLauncher` ships
   * `mcp.fileContent` — composed by the caller from the node's `ready.dataDir`
   * (spec §6.4). Additive phase-2 field; `LocalLauncher` ignores it, its file
   * was already written by `registerSubshellMcp`.
   */
  mcpConfigPath?: string;
  /** Resume pin */
  harnessSession?: { id: string; mode: "start" | "resume" };
  /**
   * A log-attach failure (log-dir mkdir or pipe-pane) is logged and ignored
   * instead of failing the launch. Used by revive, where a live pane must
   * survive a lost replay log — restores the pre-seam semantics
   * (createSubshell stays strict).
   */
  bestEffortLog?: boolean;
}

/**
 * Every machine-local operation a subshell needs, so the orchestrator never
 * touches tmux/fs/agent sockets directly (spec §6.3). LocalLauncher is
 * today's code; RemoteLauncher (phase 2) signs NodeCommandBodies.
 *
 * Phase-2 invariants (binding on implementations AND callers):
 * - Implementations whose methods await (RemoteLauncher) MUST serialize
 *   per-node dispatch in call order — the agent's seq gate drops reordered
 *   frames, so a `terminate` that overtakes a queued `launch` is silently
 *   lost, not merely late.
 * - Callers MUST NOT overlap per-subshell pumps (capture loop + poll loop,
 *   two attach streams) on one subshell: even serialized dispatch can flip
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
  /** Strict kill of the tmux subshell — throws when tmux refuses (unlike {@link killSubshell}). */
  terminate(socket: string, id: string): Promise<void>;
  /** Raw kill of the tmux subshell; swallows "already gone". */
  killSubshell(socket: string, id: string): Promise<void>;
  /** Whether a subshell with that name exists on the socket. */
  hasSubshell(socket: string, id: string): Promise<boolean>;
  /** The dead pane's exit code, null if unavailable. */
  paneExitCode(socket: string, id: string): Promise<number | null>;
  /** Pane's OSC title plus the running command, null if the pane is gone. */
  paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null>;
  /**
   * The pane's live cursor position (0-based column/row inside the viewport),
   * null when unavailable. The attach replay pairs it with the grid capture:
   * a snapshot has no cursor, and a diff-rendering TUI starts its next repaint
   * with RELATIVE moves from where it left the cursor — so without the real
   * position the client's grid silently shifts by the delta (2026-09-04
   * "garbled when I background and return while it's animating": the replay
   * cursor sat at the end of the capture text instead of the app's cursor).
   * Remote agents have no `cursor` command yet — implementations answer null
   * and the attach falls back to the pre-cursor join rule.
   */
  paneCursor(socket: string, id: string): Promise<{ x: number; y: number } | null>;
  /**
   * Snapshot of the pane's visible grid as text. With `scrollbackLines`, also
   * prepends up to that many rows of the pane's own (reflowed, rendered)
   * history — the attach-time replay ships the grid PLUS history in one clean
   * paint, instead of re-playing raw log bytes over the grid.
   */
  capture(socket: string, id: string, scrollbackLines?: number): Promise<string>;
  /** Propagates client geometry to the pane. */
  resize(socket: string, id: string, cols: number, rows: number): Promise<void>;
  /**
   * The pane's REAL size, null when the machine cannot report it.
   *
   * Read back after {@link resize} so the browser can be told what the pane
   * ended up at instead of assuming its request landed. The pane is the
   * authority for painting: a diff-rendering TUI positions every frame
   * relative to the geometry it believes it has, so a client grid that
   * differs by even one row makes every later frame land on the wrong rows —
   * permanently, until a reattach. Measured 2026-09-04: a 13-row browser
   * against a 16-row pane rendered a frozen, superimposed screen while
   * `capture-pane` stayed pristine.
   */
  paneSize(socket: string, id: string): Promise<{ cols: number; rows: number } | null>;
  /**
   * Sends `SIGWINCH` to the pane's process WITHOUT changing its size, so a
   * diff-rendering TUI repaints the grid it already has. Returns false when
   * the machine cannot deliver the signal.
   *
   * This exists because a reopen at the size the pane already has makes
   * {@link resize} a no-op — no `SIGWINCH`, no repaint, and whatever
   * half-painted frame the pane held is captured verbatim for every viewer.
   * The previous answer was to nudge the width one column and back, which
   * forces the repaint but also makes tmux REFLOW the pane's history twice;
   * on phones that reattach every minute, each reflow stamps another copy of
   * a tall inline UI into scrollback, where nothing can ever rewrite it.
   */
  signalPaneWinch(socket: string, id: string): Promise<boolean>;
  /** Types raw input into the pane (escape sequences included). */
  sendInput(socket: string, id: string, input: string): Promise<void>;
  /**
   * Types `text` into a fresh pane once it shows output and submits it — the
   * mirror of the phase-2 `prompt_deliver` command, so a remote agent runs
   * the whole settle loop as ONE round-trip. Returns `promptDelivered`
   * (false on settle timeout or failed input; never throws).
   */
  deliverPrompt(socket: string, id: string, text: string, settleTimeoutMs: number, pollMs: number): Promise<boolean>;
  /** Absolute path of the subshell's pipe-pane replay log. */
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
  /** Whether the harness can actually resume the stored subshell id in that cwd. */
  canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean>;
  /**
   * The node-side files a subshell owns — what delete removes. `[]` when the
   * machine cannot answer: an agent with no live `ready` facts has no readable
   * layout to name paths from (its artifacts age out with the node, §5.6).
   */
  subshellArtifacts(id: string): string[];
  /** Best-effort deletion of artifact paths from {@link subshellArtifacts}. */
  removeArtifacts(paths: string[]): Promise<void>;
}
