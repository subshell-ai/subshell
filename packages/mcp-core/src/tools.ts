import { ApiError } from "./api-client.js";
import type { IdentityKeyPair } from "./crypto.js";

/**
 * The shared seam of the `subshell mcp` tool implementations, factored out of
 * the MCP layer so they are testable without stdio: everything they touch goes
 * through the narrow {@link ToolApi} seam plus the pure crypto module. The
 * handlers themselves live in `channel-tools.ts` (everything that seals or
 * opens a JWE) and `subshell-tools.ts` (panes, nodes, presets, plugins).
 */

/** The request surface the tools need (satisfied by SubshellApi; stubbed in tests). */
export interface ToolApi {
  req<T>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<T>;
}

/** Everything a tool handler closes over. */
export interface ToolDeps {
  api: ToolApi;
  own: IdentityKeyPair;
}

/**
 * Maps an ApiError to the plain-English guidance agents act on. The `code`
 * branches name exactly the values the server rides by name: the
 * `throwApiError` paths (NODE_REQUIRED, NODE_OFFLINE, NODE_IN_MAINTENANCE,
 * SUBSHELL_NOT_RUNNING, RESTART_IN_FLIGHT). The create-path refusals an
 * exception class carries (`harness_disabled`, `node_launch_disabled`,
 * `preset_harness_mismatch`) do NOT reach the wire under those names: the
 * error handler genericizes status-carriers by status (a 409 answers
 * `EXISTS_ERROR`), so those ride through the status branches with their
 * message, which is where their remedy sentence already lives.
 */
export function describeToolError(err: unknown): Error {
  if (err instanceof ApiError) {
    if (err.code === "NODE_REQUIRED") {
      return new Error(
        `subshell: no launch-eligible node picked (${err.message}); call list_nodes and pass 'node' to create_subshell`,
      );
    }
    if (err.code === "NODE_OFFLINE") {
      return new Error(`subshell: the target node is offline (${err.message}); check list_nodes for an online machine`);
    }
    if (err.code === "NODE_IN_MAINTENANCE") {
      return new Error(
        `subshell: the target node is in maintenance (${err.message}); check list_nodes for another machine`,
      );
    }
    if (err.code === "SUBSHELL_NOT_RUNNING") {
      return new Error(`subshell: the subshell is not running (${err.message}); start it with restart_subshell`);
    }
    if (err.status === 401) {
      return new Error(
        "subshell: subshell token rejected (revoked or expired); restart this subshell to mint a new one",
      );
    }
    if (err.status === 403) return new Error(`subshell: permission denied: ${err.message}`);
    if (err.status === 404) return new Error(`subshell: not found: ${err.message}; find ids with list_subshells`);
    if (err.status === 409)
      return new Error(`subshell: conflict: ${err.message}; list_nodes and list_presets answer what is available`);
    return new Error(`subshell: API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
