import { z } from "zod";
import type { ToolDeps } from "./tools.js";

/**
 * The terminal-family MCP tools (spec 2026-10-02). Own file for the same
 * reason transfer-tools.ts exists: subshell-tools.ts passed its size budget
 * long ago, and the terminal family (exec today) deserves a seam of its own.
 */

/**
 * Schema for `exec_in_terminal`. MCP args stay snake_case; the verb's body is
 * camelCase. Deliberately NO min/max on `timeout_ms` (PR #319 review): the
 * server clamps (spec 2026-10-02 §2), and a hard schema bound would refuse a
 * caller asking 500 where the same intent over REST runs clamped - every
 * protocol decision lives server-side, the thin tool mirrors none. `command`
 * keeps only the empty-string refusal, so a stray "" names itself instead of
 * riding to a generic 400.
 */
export const ExecInTerminalToolSchema = {
  subshell_id: z.string().describe("The terminal pane's subshell id (find it with list_subshells)"),
  command: z
    .string()
    .min(1)
    .describe("One shell command line, typed verbatim into the pane's shell (the server caps it at 20000 chars)"),
  timeout_ms: z
    .number()
    .int()
    .optional()
    .describe(
      "How long to wait for the command; the server clamps to [1000, 300000], default 30000; a timeout never touches the pane",
    ),
};

export interface ExecInTerminalArgs {
  /** The terminal pane's subshell id */
  subshell_id: string;
  /** One shell command line, typed verbatim */
  command: string;
  /** Sentinel wait in ms; absent means the server's default (30000) */
  timeout_ms?: number;
}

/**
 * How the exec verb answers, mirroring the route's 200 schema (the server
 * holds every bound; this type is a read of its contract, not a second gate).
 */
export interface ExecInTerminalResult {
  /** completed: the sentinel arrived and exitCode is the command's status; timed_out: it did not */
  status: "completed" | "timed_out";
  /** The shell's status for the command; null unless status is completed */
  exitCode: number | null;
  /** The pane's lines from before the command until the sentinel (server-bounded, newest kept past the cap) */
  output: string;
  /** True when output dropped older lines to stay inside the server cap */
  truncated: boolean;
  /** Raw log offset just after the sentinel (or where the wait stopped); read_subshell_log's from_byte resumes there */
  nextByte: number;
}

/** `exec_in_terminal`: one command in a terminal pane, answered by the server's sentinel machinery. */
export async function execInTerminal(deps: ToolDeps, args: ExecInTerminalArgs): Promise<ExecInTerminalResult> {
  return await deps.api.req<ExecInTerminalResult>(`/api/subshells/${encodeURIComponent(args.subshell_id)}/exec`, {
    method: "POST",
    body: { command: args.command, ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}) },
  });
}
