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
const focusRequests = new Set<(subshellId: string, workspaceId?: string) => boolean>();

/**
 * Ask the dock to focus the pane running `subshellId`. Returns TRUE only if a
 * mounted consumer (the dock, or the tab strip) found and activated that pane —
 * so the caller can let the link navigate when nothing handled it: a stale pane
 * set, or no dock yet ready, must not turn the click into a dead no-op.
 *
 * `workspaceId` scopes the request to ONE workspace: a sidebar branch row
 * means "this branch's tab", and a pane filed in several workspaces must not
 * answer a branch click by activating a DIFFERENT workspace's tab (review
 * 2026-10-17). A scoped request is refused by every presentation that is not
 * standing on that workspace, and the click then navigates to the branch —
 * which is exactly the answer. Unscoped (a list row's click) means "wherever
 * its tab is", and the mounted dock answers for any workspace of its own.
 */
export function requestWorkspacePaneFocus(subshellId: string, workspaceId?: string): boolean {
  let handled = false;
  for (const listener of [...focusRequests]) {
    if (listener(subshellId, workspaceId)) handled = true;
  }
  return handled;
}

/** Subscribe to focus requests; the callback returns whether it handled one. */
export function onWorkspacePaneFocusRequest(cb: (subshellId: string, workspaceId?: string) => boolean): () => void {
  focusRequests.add(cb);
  return () => {
    focusRequests.delete(cb);
  };
}

/**
 * The ONE-SHOT focus a rail click arms when it sends you to a workspace page
 * you were not on (spec 2026-10-17: selecting a pane means going to its tab).
 * `requestWorkspacePaneFocus` only reaches a DOCK that is already mounted;
 * when the click has to navigate first, the destination presentation takes
 * this value once its panes are up and activates the matching tab. Consumed
 * by the first presentation ready to honour it — if none ever is (a dead
 * pane, a fast redirect), it is simply stale by the next navigation, and
 * `arm` overwrites rather than queues.
 */
let pendingArrivalFocus: string | null = null;

/** Arm the pane the next-ready presentation should focus. */
export function armPaneFocusOnArrive(subshellId: string): void {
  pendingArrivalFocus = subshellId;
}

/** Take the armed id exactly once (null when nothing is armed). */
export function takePaneFocusOnArrive(): string | null {
  const id = pendingArrivalFocus;
  pendingArrivalFocus = null;
  return id;
}

/** Drop every listener and the value — for tests only. @internal */
export function resetWorkspaceFocusForTests(): void {
  focusedSubshellId = null;
  pendingArrivalFocus = null;
  listeners.clear();
  focusRequests.clear();
}
