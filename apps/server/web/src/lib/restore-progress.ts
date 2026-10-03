import { useSyncExternalStore } from "react";

// Keep only the mounted restore result visible after the server revokes its
// former cookie. This grants no API access and disappears with the document.
let active = false;
const listeners = new Set<() => void>();
export function setRestoreProgressActive(value: boolean) {
  active = value;
  for (const listener of listeners) listener();
}
export function useRestoreProgressActive() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => active,
    () => false,
  );
}
