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
 * Keep titles fixed so long names can't overwhelm the dialog. The body
 * identifies the subshell and explains the consequences.
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
    title: "Close this subshell?",
    description: `This stops the process and permanently deletes "${name}" and its history. You can't undo this.`,
    confirmLabel: "Close subshell",
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
    description: `This stops the process running in "${name}" and starts it again, interrupting its current work. Whether the agent can resume its conversation depends on the agent and its saved history.`,
    confirmLabel: "Restart subshell",
    danger: true,
  });
}

/** `N subshells`, singular at one. */
function count(n: number): string {
  return `${n} subshell${n === 1 ? "" : "s"}`;
}

/**
 * Confirmation prompt before a bulk restart whose selection contains
 * `live` running subshells out of `total` (the bulk bar's twin of the
 * liveness split; a selection that is all-dead asks nothing). Counts belong
 * in the body so the title stays fixed.
 */
export function confirmRestartSubshells(total: number, live: number): Promise<boolean> {
  return confirmAction({
    title: "Restart the selected subshells?",
    // A single-row selection is necessarily the one live process.
    description:
      total === 1
        ? "This stops the selected subshell's process and starts it again, interrupting its current work. Whether the agent can resume its conversation depends on the agent and its saved history."
        : `This restarts ${count(total)}, interrupting work in ${live} running ${live === 1 ? "process" : "processes"}. Whether each agent can resume its conversation depends on the agent and its saved history.`,
    confirmLabel: "Restart subshells",
    danger: true,
  });
}

/** Confirmation prompt before closing `n` subshells (bulk {@link confirmCloseSubshell}). */
export function confirmCloseSubshells(n: number): Promise<boolean> {
  return confirmAction({
    title: "Close the selected subshells?",
    description: `This stops the processes and permanently deletes ${count(n)} and their history. You can't undo this.`,
    confirmLabel: "Close subshells",
    danger: true,
  });
}
