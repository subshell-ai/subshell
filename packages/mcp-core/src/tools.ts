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
 * branches map exactly the five values they name (NODE_REQUIRED,
 * NODE_OFFLINE, NODE_IN_MAINTENANCE, SUBSHELL_NOT_RUNNING,
 * NODE_AGENT_TOO_OLD), each of which
 * the server's `throwApiError` paths ride to the wire under that name;
 * RESTART_IN_FLIGHT rides by name too but gets no branch of its own here,
 * it answers through the 409 status branch like any other 409. The
 * create-path refusals an exception class carries (`harness_disabled`,
 * `node_launch_disabled`, `preset_harness_mismatch`) do NOT reach the wire
 * under those names: the error handler genericizes status-carriers by
 * status (a 409 answers `EXISTS_ERROR`), so those ride through the status
 * branches with their message, which is where their remedy sentence already
 * lives. Nothing is mapped that cannot arrive.
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
    if (err.code === "NODE_AGENT_TOO_OLD") {
      // The transfer verbs' `unsupported` answer lands under this code
      // (spec 2026-10-01 §5): the machine itself is fine, its binary is a
      // version behind, and only a human can close that (the Updates page).
      // The remedy sentence names only what an agent can actually verify:
      // list_nodes rows carry no version, so pointing at one asked the agent
      // to check a fact the tool does not report.
      return new Error(
        `subshell: the agent on the target node predates this command (${err.message}); ask a human to update that node's agent, or choose an agent node whose panes already answer this verb`,
      );
    }
    if (err.status === 401) {
      // The auth-guard answers revoked, expired, gone-row and disabled-owner
      // ALL as a bare 401 on purpose (a distinct code would be an oracle into
      // token state), so the client cannot name the cause and must not try to.
      // What it CAN say truthfully, to the AGENT who reads this (not a human):
      // every subshell tool rides this one bearer, so the whole surface is
      // down, not just this call; and the token cannot be renewed from in here
      // - a self-restart is the ONE move that terminates the caller (the
      // restart_subshell contract), so the message must not point at it. The
      // remedy belongs to a human, and saying so is the whole fix.
      return new Error(
        "subshell: this pane's MCP token is revoked or expired, so every subshell tool is unavailable until it is renewed. You cannot renew it from inside the pane, and calling restart_subshell on your own pane would terminate you: ask a human to restart this subshell.",
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
