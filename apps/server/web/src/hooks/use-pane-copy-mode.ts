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
    const stored = setPaneCopyModeIds(togglePaneCopyMode(paneCopyModeIds(), subshellId));
    // The store decides what this press did, and the button and the toast both
    // read that answer. They cannot read `on`: React has not committed the
    // re-render yet when the second of two surfaces presses in the same batch,
    // so its `on` can be the state the first press just replaced. (The comment
    // here used to claim the two were always equal, which is what hid this.)
    // What keeps the menu and the touch bar agreeing is the module's page-load
    // memory plus the `PANE_COPY_MODE_CHANGED` re-read in the effect above.
    const nowOn = stored.includes(subshellId);
    setMode({ id: subshellId, on: nowOn });
    toast.success(nowOn ? "Text copying enabled" : "Text input enabled");
  }
  return { on, onToggle };
}
