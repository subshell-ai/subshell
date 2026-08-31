/**
 * Confirmation prompts for destructive session actions, asked by
 * `useSessionMutations` (the menu, the cards, the rows, the terminal's
 * exited panel) and by the workspace's pane header, so the wording — and
 * the fact that these actions ask at all — stays identical wherever they
 * are triggered from.
 *
 * Terminate and delete confirm; restart does not (it creates a session and
 * resumes the conversation — nothing is lost by clicking it).
 *
 * Wording rule: the TITLE is the question with the session's name in it;
 * the DESCRIPTION is the one-sentence consequence. Never a whole sentence
 * as the heading — the dialog renders the title large.
 *
 * They render through the app-wide styled dialog (`lib/confirm`), so they
 * are async: `if (await confirmDeleteSession(name)) …`.
 */

import { confirmAction } from "@/lib/confirm";

/**
 * Confirmation prompt before terminating a session's process.
 * @param name - The session's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmTerminateSession(name: string): Promise<boolean> {
  return confirmAction({
    title: `Terminate session "${name}"?`,
    description: "You will be able to resume the session later at any time.",
    confirmLabel: "Terminate",
    danger: true,
  });
}

/**
 * Confirmation prompt before deleting a session outright.
 * @param name - The session's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmDeleteSession(name: string): Promise<boolean> {
  return confirmAction({
    title: `Delete session "${name}"?`,
    description: "This will remove the session entirely and cannot be recovered / resumed.",
    confirmLabel: "Delete",
    danger: true,
  });
}

/** `N sessions`, singular at one. */
function count(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

/**
 * Confirmation prompt before terminating `n` sessions — the bulk variant of
 * {@link confirmTerminateSession}, kept beside it so a wording change
 * touches one file.
 */
export function confirmTerminateSessions(n: number): Promise<boolean> {
  return confirmAction({
    title: `Terminate ${count(n)}?`,
    description: "You will be able to resume each of them later at any time.",
    confirmLabel: "Terminate",
    danger: true,
  });
}

/** Confirmation prompt before deleting `n` sessions (bulk {@link confirmDeleteSession}). */
export function confirmDeleteSessions(n: number): Promise<boolean> {
  return confirmAction({
    title: `Delete ${count(n)}?`,
    description: "This will remove them entirely and they cannot be recovered / resumed.",
    confirmLabel: "Delete",
    danger: true,
  });
}
