import { useCallback } from "react";
import { useOpenPaneAsTab } from "@/hooks/use-open-pane-as-tab";
import { armWorkspacePreview, requestWorkspacePreview } from "@/lib/workspace-preview";
import type { SubshellView } from "@/types/subshell";

export function useOpenVirtualDisplay(subshell: SubshellView | undefined) {
  const openAsTab = useOpenPaneAsTab();
  return useCallback(() => {
    if (!subshell) return;
    if (requestWorkspacePreview(subshell.id)) return;
    armWorkspacePreview(subshell.id);
    void openAsTab(subshell);
  }, [subshell, openAsTab]);
}
