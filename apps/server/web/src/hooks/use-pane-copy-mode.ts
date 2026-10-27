import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  PANE_COPY_MODE_CHANGED,
  paneCopyModeIds,
  setPaneCopyModeIds,
  togglePaneCopyMode,
} from "@/lib/pane-copy-mode-pref";

/** One persisted mode and confirmation shared by the menu and touch bar. */
export function usePaneCopyMode(subshellId: string) {
  const [mode, setMode] = useState(() => ({ id: subshellId, on: paneCopyModeIds().includes(subshellId) }));
  const on = mode.id === subshellId ? mode.on : paneCopyModeIds().includes(subshellId);
  useEffect(() => {
    const update = () => setMode({ id: subshellId, on: paneCopyModeIds().includes(subshellId) });
    update();
    window.addEventListener(PANE_COPY_MODE_CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(PANE_COPY_MODE_CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, [subshellId]);
  function onToggle() {
    const nextOn = !on;
    const stored = setPaneCopyModeIds(togglePaneCopyMode(paneCopyModeIds(), subshellId));
    // This binds the pressing surface to what the module now holds. The agreement
    // between the menu and the touch bar does NOT ride this line: the setter
    // always returns the attempted set, so `stored` says the same thing as
    // `nextOn`. What makes a refused write visible to the surface that did not
    // press is the module's page-load memory plus the `PANE_COPY_MODE_CHANGED`
    // re-read in the effect above.
    setMode({ id: subshellId, on: stored.includes(subshellId) });
    toast.success(nextOn ? "Text copying enabled" : "Text input enabled");
  }
  return { on, onToggle };
}
