import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import type { PreviewChoice } from "@/components/preview/preview-section";
import { PreviewTabContent } from "@/components/preview/preview-tab-content";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";
import type { DockedPaneParams } from "@/components/workspace-dock/docked-pane";

export function DockedPreview(props: IDockviewPanelProps<DockedPaneParams>) {
  const { detail } = useWorkspaceDockContext();
  const pane = detail.panes.find((row) => row.id === props.params.paneId);
  const [choice, setChoice] = useState<PreviewChoice | null>(null);
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const listener = props.api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => listener.dispose();
  }, [props.api]);
  return pane && visible ? (
    <PreviewTabContent subshellId={pane.subshellId} choice={choice} onViewChange={setChoice} />
  ) : null;
}
