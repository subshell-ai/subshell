/**
 * Environment contract for the `subshell mcp` stdio process. The parent (the
 * subshell-manager, via tmux) injects these; the child reads them once at
 * startup and never re-derives them.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the MCP process needs to reach the backend as its subshell. */
export interface McpEnv {
  /**
   * The per-subshell bearer token (SUBSHELL_API_KEY). Empty string in runtime
   * pane mode (`callbackSock` set): the plane authenticates every callback as
   * this pane by the DOOR it arrived on, and the real token never crosses to
   * the destination (design 2026-10-05 §5), so there is nothing to hold.
   */
  apiKey: string;
  /** Backend base URL (SUBSHELL_BASE_URL), defaulting to the local server. */
  baseUrl: string;
  /** The subshell id this process speaks as (SUBSHELL_ID). */
  subshellId: string;
  /** Where to persist the keypair (SUBSHELL_DATA_DIR). */
  dataDir: string;
  /** Optional display name for the identity (SUBSHELL_NAME). */
  subshellName: string | null;
  /**
   * The pane's callback door (SUBSHELL_RUNTIME_CALLBACK_SOCK): a unix socket
   * path, set only for panes an SSH runtime session launched. When present,
   * every backend call rides that door (see `SubshellApi`/`runReport`) and the
   * base URL is never contacted - the pane env carries a never-resolves
   * sentinel there precisely so an accidental direct call dies at DNS.
   */
  callbackSock: string | null;
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
  // The runtime pane door (design 2026-10-05 §5, task 25): with a door, the
  // pane has no key BY DESIGN - the plane executes every callback as the pane
  // from the pane's own minted token, which never travels to the destination.
  // Without a door the key is as required as it always was; the error text
  // stays the pre-door sentence so every non-runtime pane's failure reads
  // exactly as it did before this field existed.
  const rawSock = env.SUBSHELL_RUNTIME_CALLBACK_SOCK;
  let callbackSock = rawSock !== undefined && rawSock.trim() !== "" ? rawSock.trim() : null;
  // A door is an absolute filesystem path (the plane composes it from the
  // runtime's `hello.dataDir`). A relative value cannot be what was meant:
  // it would resolve against the harness's cwd, which the pane env never
  // composes. Treat it as NO door (the key-required path, loud on stderr)
  // rather than dialing some other path beside the user's project.
  if (callbackSock !== null && !callbackSock.startsWith("/")) {
    process.stderr.write(
      `subshell mcp: ignoring SUBSHELL_RUNTIME_CALLBACK_SOCK "${callbackSock}" (not an absolute path); requiring SUBSHELL_API_KEY\n`,
    );
    callbackSock = null;
  }
  if (!apiKey && callbackSock === null) throw new Error("subshell mcp: SUBSHELL_API_KEY is not set");
  if (!subshellId) throw new Error("subshell mcp: SUBSHELL_ID is not set");
  return {
    apiKey: apiKey ?? "",
    baseUrl: env.SUBSHELL_BASE_URL ?? "http://127.0.0.1:3080",
    subshellId,
    dataDir: resolveMcpDataDir(env),
    subshellName: env.SUBSHELL_NAME ?? null,
    callbackSock,
  };
}
