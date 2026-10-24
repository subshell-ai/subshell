import {
  parseWorkspacePreviewId,
  type WorkspacePreviewTarget,
  workspacePreviewId,
  workspacePreviewLabel,
} from "@internal/subshell-protocol";
import { useSyncExternalStore } from "react";

export type { WorkspacePreviewTarget };
export { parseWorkspacePreviewId, workspacePreviewLabel };

export interface WorkspacePreviewEntry {
  id: string;
  paneId: string;
  subshellId: string;
  workspaceId: string;
  view: WorkspacePreviewTarget;
}
export const previewPanelId = workspacePreviewId;
export function previewParentId(panelId: string): string | null {
  return parseWorkspacePreviewId(panelId)?.paneId ?? null;
}
// Only the mounted workspace publishes entries. Desktop persistence stays in its
// dock layout; this store connects that presentation to the sidebar.
let entries: readonly WorkspacePreviewEntry[] = [];
let focused: string | null = null;
const listeners = new Set<() => void>();
const requests = new Set<(subshellId: string, view?: WorkspacePreviewTarget) => boolean>();
let pendingPreview: string | null = null;
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
export function requestWorkspacePreview(subshellId: string, view?: WorkspacePreviewTarget): boolean {
  for (const request of requests) if (request(subshellId, view)) return true;
  return false;
}
export function onWorkspacePreviewRequest(request: (subshellId: string, view?: WorkspacePreviewTarget) => boolean) {
  requests.add(request);
  flushWorkspacePreview();
  return () => {
    requests.delete(request);
  };
}

/** Carries a header shortcut through navigation until its workspace is ready. */
export function armWorkspacePreview(subshellId: string) {
  pendingPreview = subshellId;
}
export function flushWorkspacePreview() {
  if (pendingPreview && requestWorkspacePreview(pendingPreview)) pendingPreview = null;
}
