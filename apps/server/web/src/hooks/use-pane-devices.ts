import type { ViewersState } from "@internal/subshell-protocol";
import { useEffect, useSyncExternalStore } from "react";

type SetSizing = (mode: "auto" | "pinned", viewerId?: string | null) => void;
interface PaneDevices {
  state: ViewersState;
  onSizing: SetSizing;
}

// Dockview owns the terminal subtree; the page header lives outside it.
// Publish presence from the existing socket without attaching another viewer.
const panes = new Map<string, PaneDevices>();
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePublishPaneDevices(paneId: string, state: ViewersState | null, onSizing: SetSizing) {
  useEffect(() => {
    if (!state) return;
    const entry = { state, onSizing };
    panes.set(paneId, entry);
    emit();
    return () => {
      // A replacement terminal may already have published for the same pane.
      if (panes.get(paneId) !== entry) return;
      panes.delete(paneId);
      emit();
    };
  }, [paneId, state, onSizing]);
}

export function usePaneDevices(paneId: string | undefined): PaneDevices | null {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? (panes.get(paneId) ?? null) : null),
    () => null,
  );
}
