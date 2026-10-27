import { useCallback, useEffect, useState } from "react";
import {
  paneDiagnosticsIds,
  setPaneDiagnosticsIds,
  subscribePaneDiagnostics,
  togglePaneDiagnostics,
} from "@/lib/pane-diagnostics-pref";

/**
 * The diagnostics HUD posture for one subshell on THIS device, readable and
 * toggleable from anywhere — the same per-page posture the subshell route
 * owns inline, shaped as a hook so the workspace's two halves (the focused
 * pane's menu in the header, the dock terminal below it) can share one
 * preference without either owning the other.
 *
 * Every read goes back to the preference module rather than to local state, so
 * a change from the other component, or from another tab of this device, is
 * what renders; a toggle never has to know who is listening. The module reads
 * storage, except for the rest of a page load whose writes the device refused,
 * where it answers from the set it tried to store so both halves agree.
 *
 * @param id - the subshell whose HUD this is, or undefined while no pane is
 *             in view (reads off, toggles do nothing)
 * @returns `[on, toggle]` — whether the HUD is open, and the menu's act
 */
export function usePaneDiagnostics(id: string | undefined): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!id) {
      setOn(false);
      return;
    }
    const sync = (): void => setOn(paneDiagnosticsIds().includes(id));
    sync();
    return subscribePaneDiagnostics(sync);
  }, [id]);
  const toggle = useCallback((): void => {
    if (!id) return;
    // Bind the render to what the store actually holds, the way the subshell
    // page does: `setPaneDiagnosticsIds` returns the set it tried to persist,
    // and a refused write (private mode, quota) still holds for this page load.
    // Reading the preference back instead would drop the click on the floor.
    const next = setPaneDiagnosticsIds(togglePaneDiagnostics(paneDiagnosticsIds(), id));
    setOn(next.includes(id));
  }, [id]);
  return [on, toggle];
}
