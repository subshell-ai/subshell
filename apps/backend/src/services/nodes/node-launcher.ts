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
  /** Resume pin */
  harnessSession?: { id: string; mode: "start" | "resume" };
  /**
   * A pipe-pane attach failure is logged and ignored instead of failing the
   * launch. Used by revive, where a live pane must survive a lost log pipe —
   * restores the pre-seam semantics (createSession stays strict).
   */
  bestEffortLog?: boolean;
}

/**
 * Every machine-local operation a session needs, so the orchestrator never
 * touches tmux/fs/agent sockets directly (spec §6.3). LocalLauncher is
 * today's code; RemoteLauncher (phase 2) signs NodeCommandBodies.
 */
export interface NodeLauncher {
  validateWorkingDir(raw: string): Promise<string>;
  resolveBinary(harness: HarnessPlugin): Promise<string | null>;
  launch(plan: LaunchPlan): Promise<void>;
  terminate(socket: string, id: string): Promise<void>;
  killSession(socket: string, id: string): Promise<void>;
  hasSession(socket: string, id: string): Promise<boolean>;
  paneExitCode(socket: string, id: string): Promise<number | null>;
  paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null>;
  capture(socket: string, id: string): Promise<string>;
  resize(socket: string, id: string, cols: number, rows: number): Promise<void>;
  sendInput(socket: string, id: string, input: string): Promise<void>;
  pressEnter(socket: string, id: string): Promise<void>;
  /**
   * Types `text` into a fresh pane once it shows output and submits it — the
   * mirror of the phase-2 `prompt_deliver` command, so a remote agent runs
   * the whole settle loop as ONE round-trip. Returns `promptDelivered`
   * (false on settle timeout or failed input; never throws).
   */
  deliverPrompt(socket: string, id: string, text: string, settleTimeoutMs: number, pollMs: number): Promise<boolean>;
  logPath(id: string): string;
  readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }>;
  readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }>;
  tailStart(
    id: string,
    subId: string,
    fromByte: number,
    onChunk: (bytes: Uint8Array, next: number) => void,
  ): Promise<() => void>;
  canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean>;
  writeArtifact(id: string, kind: "mcp-config", content: string): Promise<string>;
  removeArtifacts(paths: string[]): Promise<void>;
}
