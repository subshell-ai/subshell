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
 * Restart has no confirm (it revives the same subshell and resumes the
 * conversation — nothing is lost by clicking it).
 *
 * Wording rule: the TITLE is the question with the subshell's name in it;
 * the DESCRIPTION is the one-sentence consequence. Never a whole sentence
 * as the heading — the dialog renders the title large.
 *
 * They render through the app-wide styled dialog (`lib/confirm`), so they
 * are async: `if (await confirmCloseSubshell(name)) …`.
 */

import { confirmAction } from "@/lib/confirm";

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
