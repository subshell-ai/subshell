/**
 * Environment contract for the `subshell mcp` stdio process. The parent (the
 * session-manager, via tmux) injects these; the child reads them once at
 * startup and never re-derives them.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the MCP process needs to reach the backend as its session. */
export interface McpEnv {
  /** The per-session bearer token (SUBSHELL_API_KEY). */
  apiKey: string;
  /** Backend base URL (SUBSHELL_BASE_URL), defaulting to the local server. */
  baseUrl: string;
  /** The session id this process speaks as (SUBSHELL_SESSION_ID). */
  sessionId: string;
  /** Where to persist the keypair (SUBSHELL_DATA_DIR). */
  dataDir: string;
  /** Optional display name for the identity (SUBSHELL_SESSION_NAME). */
  sessionName: string | null;
}

/**
 * Resolves where the MCP process persists local state (identity keypairs,
 * channel peer pins). Falls back to a tmp dir, NOT the cwd: a manually
 * exported SUBSHELL_API_KEY (e.g. debugging outside a subshell pane) must not drop
 * keypairs into whatever project directory the harness happens to run in.
 */
export function resolveMcpDataDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSHELL_DATA_DIR ?? env.SESSION_DATA_DIR ?? join(tmpdir(), "subshell-mcp");
}

/** Reads and validates the MCP env, throwing a clear message if incomplete. */
export function readMcpEnv(env: NodeJS.ProcessEnv = process.env): McpEnv {
  const apiKey = env.SUBSHELL_API_KEY;
  const sessionId = env.SUBSHELL_SESSION_ID;
  if (!apiKey) throw new Error("subshell mcp: SUBSHELL_API_KEY is not set");
  if (!sessionId) throw new Error("subshell mcp: SUBSHELL_SESSION_ID is not set");
  return {
    apiKey,
    baseUrl: env.SUBSHELL_BASE_URL ?? "http://127.0.0.1:3080",
    sessionId,
    dataDir: resolveMcpDataDir(env),
    sessionName: env.SUBSHELL_SESSION_NAME ?? null,
  };
}
