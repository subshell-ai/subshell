import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Whether the app is foregrounded right now — the poll policy's first input
 * (spec §Transport: polling stops in background). Shared by every polled hook
 * so "foreground" means the same thing on every screen.
 */
export function useForeground(): boolean {
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setForeground(s === "active"));
    return () => sub.remove();
  }, []);
  return foreground;
}
