/**
 * Confirmation prompts for destructive subshell actions, asked by
 * `useSubshellMutations` (the menu, the cards, the rows, the terminal's
 * exited panel) and by the workspace's pane header, so the wording — and
 * the fact that these actions ask at all — stays identical wherever they
 * are triggered from.
 *
 * Terminate and delete confirm; restart does not (it creates a subshell and
 * resumes the conversation — nothing is lost by clicking it).
 *
 * Wording rule: the TITLE is the question with the subshell's name in it;
 * the DESCRIPTION is the one-sentence consequence. Never a whole sentence
 * as the heading — the dialog renders the title large.
 *
 * They render through the app-wide styled dialog (`lib/confirm`), so they
 * are async: `if (await confirmDeleteSubshell(name)) …`.
 */

import { confirmAction } from "@/lib/confirm";

/**
 * Confirmation prompt before terminating a subshell's process.
 * @param name - The subshell's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmTerminateSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: `Terminate subshell "${name}"?`,
    description: "You will be able to resume the subshell later at any time.",
    confirmLabel: "Terminate",
    danger: true,
  });
}

/**
 * Confirmation prompt before deleting a subshell outright.
 * @param name - The subshell's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmDeleteSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: `Delete subshell "${name}"?`,
    description: "This will remove the subshell entirely and cannot be recovered / resumed.",
    confirmLabel: "Delete",
    danger: true,
  });
}

/** `N subshells`, singular at one. */
function count(n: number): string {
  return `${n} subshell${n === 1 ? "" : "s"}`;
}

/**
 * Confirmation prompt before terminating `n` subshells — the bulk variant of
 * {@link confirmTerminateSubshell}, kept beside it so a wording change
 * touches one file.
 */
export function confirmTerminateSubshells(n: number): Promise<boolean> {
  return confirmAction({
    title: `Terminate ${count(n)}?`,
    description: "You will be able to resume each of them later at any time.",
    confirmLabel: "Terminate",
    danger: true,
  });
}

/** Confirmation prompt before deleting `n` subshells (bulk {@link confirmDeleteSubshell}). */
export function confirmDeleteSubshells(n: number): Promise<boolean> {
  return confirmAction({
    title: `Delete ${count(n)}?`,
    description: "This will remove them entirely and they cannot be recovered / resumed.",
    confirmLabel: "Delete",
    danger: true,
  });
}
