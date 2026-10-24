import { useSyncExternalStore } from "react";

export interface WorkspacePreviewEntry {
  id: string;
  paneId: string;
  subshellId: string;
  workspaceId: string;
}
export function previewPanelId(paneId: string): string {
  return `preview:${paneId}`;
}
export function previewParentId(panelId: string): string | null {
  return panelId.startsWith("preview:") ? panelId.slice(8) : null;
}
// Only the mounted workspace publishes entries. Desktop persistence stays in its
// dock layout; this store connects that presentation to the sidebar.
let entries: readonly WorkspacePreviewEntry[] = [];
let focused: string | null = null;
const listeners = new Set<() => void>();
const requests = new Set<(subshellId: string, view?: "screen") => boolean>();
let pendingScreen: string | null = null;
function emit() {
  for (const listener of listeners) listener();
}
export function publishWorkspacePreviews(next: readonly WorkspacePreviewEntry[], activeId: string | null) {
  if (JSON.stringify(entries) === JSON.stringify(next) && focused === activeId) return;
  entries = next;
  focused = activeId;
  emit();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useWorkspacePreviews() {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );
}
export function useFocusedPreview() {
  return useSyncExternalStore(
    subscribe,
    () => focused,
    () => focused,
  );
}
export function requestWorkspacePreview(subshellId: string, view?: "screen"): boolean {
  for (const request of requests) if (request(subshellId, view)) return true;
  return false;
}
export function onWorkspacePreviewRequest(request: (subshellId: string, view?: "screen") => boolean) {
  requests.add(request);
  flushWorkspaceScreen();
  return () => {
    requests.delete(request);
  };
}

/** Carries a header shortcut through navigation until its workspace is ready. */
export function armWorkspaceScreen(subshellId: string) {
  pendingScreen = subshellId;
}
export function flushWorkspaceScreen() {
  if (pendingScreen && requestWorkspacePreview(pendingScreen, "screen")) pendingScreen = null;
}
