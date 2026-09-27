import { useSyncExternalStore } from "react";

/**
 * Which pane the workspace dock currently has focused, as a SUBSHELL id
 * (null when no workspace is up, or the dock has no active panel).
 *
 * The rail needs this and cannot reach the dock: the sidebar lives in the app
 * shell, a different tree from the workspace route that owns dockview. So the
 * dock publishes here on every active-panel change and the rail reads it, the
 * same decoupling `lib/server-status.ts` uses (a module store + a
 * `useSyncExternalStore` accessor). One value, app-wide, is enough: only one
 * workspace page is ever mounted, and the dock clears it on unmount, so a stale
 * focus never outlives the page that set it.
 *
 * The rail renders TWO things off this: the focused pane wears the white ring;
 * every pane the workspace holds open keeps the softer selected fill. They are
 * deliberately different signals, so they are deliberately different sources —
 * this store is the single focus, `useWorkspace`'s panes are the set.
 */
let focusedSubshellId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Publish the dock's current focus (null clears it). No-op when unchanged. */
export function setWorkspaceFocusedId(subshellId: string | null): void {
  if (subshellId === focusedSubshellId) return;
  focusedSubshellId = subshellId;
  emit();
}

/** Read the current focus without subscribing (for non-React callers). */
export function getWorkspaceFocusedId(): string | null {
  return focusedSubshellId;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The focused pane's subshell id, re-rendering the reader when focus moves. */
export function useWorkspaceFocusedId(): string | null {
  return useSyncExternalStore(subscribe, getWorkspaceFocusedId, getWorkspaceFocusedId);
}

/**
 * The OTHER direction: a request for the dock to FOCUS a given pane, emitted by
 * the rail when a click lands on a cell/row that is a pane of the current
 * workspace. Those panes are links, and a link would navigate to
 * `/subshells/:id` and leave the workspace — but the person clicked something
 * that is ALREADY open, so it should just focus that tab instead (operator
 * report 2026-09-27). The dock owns dockview and turns the request into
 * `setActive()`; the resulting activation then flows back through the focus
 * value above, so the rail's ring follows. A plain event bus, not a snapshot:
 * a request is a transient command, and there is no "current request" to read.
 */
const focusRequests = new Set<(subshellId: string) => boolean>();

/**
 * Ask the dock to focus the pane running `subshellId`. Returns TRUE only if a
 * mounted consumer (the dock, or the tab strip) found and activated that pane —
 * so the caller can let the link navigate when nothing handled it: a stale pane
 * set, or no dock yet ready, must not turn the click into a dead no-op.
 */
export function requestWorkspacePaneFocus(subshellId: string): boolean {
  let handled = false;
  for (const listener of [...focusRequests]) {
    if (listener(subshellId)) handled = true;
  }
  return handled;
}

/** Subscribe to focus requests; the callback returns whether it handled one. */
export function onWorkspacePaneFocusRequest(cb: (subshellId: string) => boolean): () => void {
  focusRequests.add(cb);
  return () => {
    focusRequests.delete(cb);
  };
}

/** Drop every listener and the value — for tests only. @internal */
export function resetWorkspaceFocusForTests(): void {
  focusedSubshellId = null;
  listeners.clear();
  focusRequests.clear();
}
