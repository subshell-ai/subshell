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
 * Add guidance for API errors that agents can act on.
 *
 * Match only codes the server exposes. RESTART_IN_FLIGHT uses the generic
 * 409 branch. Create-path errors such as harness_disabled,
 * node_launch_disabled, and preset_harness_mismatch reach clients through
 * their HTTP status, not those internal names. Their messages already explain
 * the remedy, so preserve them in the status-based fallback.
 */
export function describeToolError(err: unknown): Error {
  if (err instanceof ApiError) {
    if (err.code === "NODE_REQUIRED") {
      return new Error(
        `subshell: choose a node where you can launch subshells (${err.message}); call list_nodes and pass 'node' to create_subshell`,
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
        `subshell: the Subshell daemon on the target node doesn't support this command (${err.message}); ask a human to update its Subshell daemon, or choose a node that supports this command`,
      );
    }
    if (err.code === "EXEC_PANE_BUSY") {
      return new Error(
        `subshell: the pane is producing output, nothing was typed (${err.message}); read it first or wait, then retry`,
      );
    }
    if (err.code === "EXEC_TERMINAL_ONLY") {
      return new Error(
        `subshell: exec runs shell commands in terminal panes only (${err.message}); to type into this pane, use send_to_subshell`,
      );
    }
    if (err.code === "EXEC_IN_FLIGHT") {
      return new Error(
        `subshell: another command is already running in this terminal (${err.message}); retry once it finishes`,
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
        "subshell: this pane's MCP credentials were rejected, so its Subshell tools are unavailable. Ask a human to check your account access and restart this subshell if needed. You can't renew the token from inside the pane. Never call restart_subshell on your own pane: it would terminate you.",
      );
    }
    if (err.status === 403) return new Error(`subshell: permission denied: ${err.message}`);
    if (err.status === 404) return new Error(`subshell: not found: ${err.message}; find ids with list_subshells`);
    if (err.status === 409)
      return new Error(`subshell: conflict: ${err.message}; use list_nodes and list_presets to check what's available`);
    return new Error(`subshell: API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
