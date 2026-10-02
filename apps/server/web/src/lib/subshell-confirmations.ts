/**
 * Confirmation prompts for the destructive subshell action, asked by
 * `useSubshellMutations` (the menu, the cards, the rows, the terminal's
 * exited panel) and by the workspace's pane header, so the wording — and
 * the fact that it asks at all — stays identical wherever it is triggered
 * from.
 *
 * "Close" is the human word for DELETE (spec 2026-09-03 close-vocabulary
 * design): it stops the process AND removes the row and its log. It replaced
 * both the old Delete wording and the separate Terminate action, because
 * stop-without-delete had no human use-case (agents keep terminate via MCP).
 * Restart is split by liveness (operator ruling 2026-10-02): reviving a DEAD
 * row asks nothing, because it resumes the same subshell and nothing is
 * lost, while restarting a LIVE one kills its running process, so it asks,
 * through {@link confirmRestartSubshell}. The live item exists so a pane
 * whose MCP token died can be renewed from the menu instead of being closed.
 *
 * Wording rule: the DESCRIPTION is the consequence. Close names the subshell
 * in its TITLE (the 2026-09-03 design predates the later ruling); prompts
 * added since keep the title a static question and let the body carry the
 * name (ruling 2026-09-30). Never a whole sentence as the heading, because
 * the dialog renders the title large.
 *
 * They render through the app-wide styled dialog (`lib/confirm`), so they
 * are async: `if (await confirmCloseSubshell(name)) …`.
 */

import { confirmAction } from "@internal/node-admin";

/**
 * Confirmation prompt before closing a subshell — DELETE with its full
 * consequence spelled out (the endpoint terminates a running process first).
 * @param name - The subshell's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmCloseSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: `Close subshell "${name}"?`,
    description: "This stops the process and removes the subshell and its history permanently. It cannot be recovered.",
    confirmLabel: "Close",
    danger: true,
  });
}

/**
 * Confirmation prompt before restarting a LIVE subshell: the endpoint kills
 * the running process and relaunches the same row (same id, the log
 * continues, and a fresh MCP token is minted). Reviving a dead row asks
 * nothing (see the module header), so this prompt guards only the case with
 * something to lose.
 * @param name - The subshell's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmRestartSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: "Restart this subshell?",
    description: `This stops the running process in "${name}" and starts the same subshell again in a new pane. Whatever it was mid-way through is lost.`,
    confirmLabel: "Restart",
    danger: true,
  });
}

/** `N subshells`, singular at one. */
function count(n: number): string {
  return `${n} subshell${n === 1 ? "" : "s"}`;
}

/** Confirmation prompt before closing `n` subshells (bulk {@link confirmCloseSubshell}). */
export function confirmCloseSubshells(n: number): Promise<boolean> {
  return confirmAction({
    title: `Close ${count(n)}?`,
    description: "This stops their processes and removes them entirely. They cannot be recovered.",
    confirmLabel: "Close",
    danger: true,
  });
}
