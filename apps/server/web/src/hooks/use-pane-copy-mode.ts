import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PANE_COPY_MODE_CHANGED, paneCopyModeIds, setPaneCopyModeIds } from "@/lib/pane-copy-mode-pref";

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
    const otherIds = paneCopyModeIds().filter((id) => id !== subshellId);
    setPaneCopyModeIds(nextOn ? [...otherIds, subshellId] : otherIds);
    setMode({ id: subshellId, on: nextOn });
    toast.success(nextOn ? "Text copying enabled" : "Text input enabled");
  }
  return { on, onToggle };
}
