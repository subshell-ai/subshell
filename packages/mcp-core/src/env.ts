/**
 * Environment contract for the `subshell mcp` stdio process. The parent (the
 * subshell-manager, via tmux) injects these; the child reads them once at
 * startup and never re-derives them.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the MCP process needs to reach the backend as its subshell. */
export interface McpEnv {
  /** The per-subshell bearer token (SUBSHELL_API_KEY). */
  apiKey: string;
  /** Backend base URL (SUBSHELL_BASE_URL), defaulting to the local server. */
  baseUrl: string;
  /** The subshell id this process speaks as (SUBSHELL_ID). */
  subshellId: string;
  /** Where to persist the keypair (SUBSHELL_DATA_DIR). */
  dataDir: string;
  /** Optional display name for the identity (SUBSHELL_NAME). */
  subshellName: string | null;
}

/**
 * Resolves where the MCP process persists local state (identity keypairs,
 * channel peer pins). Falls back to a tmp dir, NOT the cwd: a manually
 * exported SUBSHELL_API_KEY (e.g. debugging outside a subshell pane) must not drop
 * keypairs into whatever project directory the harness happens to run in.
 */
export function resolveMcpDataDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSHELL_DATA_DIR ?? env.SUBSHELL_SERVER_DATA_DIR ?? join(tmpdir(), "subshell-mcp");
}

/** Reads and validates the MCP env, throwing a clear message if incomplete. */
export function readMcpEnv(env: NodeJS.ProcessEnv = process.env): McpEnv {
  const apiKey = env.SUBSHELL_API_KEY;
  const subshellId = env.SUBSHELL_ID;
  if (!apiKey) throw new Error("subshell mcp: SUBSHELL_API_KEY is not set");
  if (!subshellId) throw new Error("subshell mcp: SUBSHELL_ID is not set");
  return {
    apiKey,
    baseUrl: env.SUBSHELL_BASE_URL ?? "http://127.0.0.1:3080",
    subshellId,
    dataDir: resolveMcpDataDir(env),
    subshellName: env.SUBSHELL_NAME ?? null,
  };
}
