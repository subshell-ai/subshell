/**
 * Which workspace the person is standing in, module-side (spec 2026-10-17).
 *
 * Two related facts, deliberately stored apart:
 *
 * - The CURRENT one is live component state — set by the workspace detail page
 *   while it is mounted. It answers "where should a New subshell land?" for
 *   launch dialogs raised anywhere in the shell while that page is on screen.
 *   A launch with no current workspace is not a failure: the pane simply
 *   starts ungrouped, which is what every bearer/MCP create does too. It is
 *   module memory rather than a context because the dialogs read it at submit
 *   time from portals that cannot see a provider.
 * - The LAST one is a per-device localStorage preference, written on the same
 *   mount and read by `/` to decide what to show first. Only a workspace whose
 *   page actually rendered gets remembered, so a dead link never poisons the
 *   landing.
 */

const LAST_KEY = "subshell.lastWorkspaceId";

/** The workspace page currently mounted, or null on any other screen. */
let currentId: string | null = null;

/** Marks `id` as the on-screen workspace; call with null on unmount. */
export function setCurrentWorkspace(id: string | null): void {
  currentId = id;
}

/** The workspace the launch dialogs should file new panes into, if any. */
export function currentWorkspaceId(): string | null {
  return currentId;
}

/**
 * One-shot: the landing's first "New subshell" press asks the shared create
 * hook to open a fresh workspace for the pane it is about to launch (there is
 * no window to join yet). Consumed exactly once by the next submit and thrown
 * away by closing the dialog, so the request can never leak into a later,
 * unrelated launch.
 */
let wantsFreshWorkspace = false;

/** Arm the next launch to open its own workspace (landing empty state only). */
export function requestCreateInNewWorkspace(): void {
  wantsFreshWorkspace = true;
}

/** Take the one-shot: true exactly once, for the submit that asks. */
export function consumeCreateInNewWorkspace(): boolean {
  const asked = wantsFreshWorkspace;
  wantsFreshWorkspace = false;
  return asked;
}

/** Remembers `id` as this device's landing workspace. */
export function rememberLastWorkspace(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // storage unavailable — the landing falls back to recency, which is fine
  }
}

/** The workspace `/` should open first, or null when none is known. */
export function lastWorkspaceId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Stops tracking a removed workspace so the landing never opens a dead id. */
export function forgetLastWorkspace(id: string): void {
  try {
    if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
  } catch {
    // nothing stored, nothing to forget
  }
}
