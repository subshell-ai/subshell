import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import type { PreviewChoice } from "@/components/preview/preview-section";
import { PreviewTabContent } from "@/components/preview/preview-tab-content";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";
import type { DockedPaneParams } from "@/components/workspace-dock/docked-pane";

export interface DockedPreviewParams extends DockedPaneParams {
  requestedView?: "screen";
  viewRequest?: string;
}

export function DockedPreview(props: IDockviewPanelProps<DockedPreviewParams>) {
  const { detail } = useWorkspaceDockContext();
  const pane = detail.panes.find((row) => row.id === props.params.paneId);
  const [selection, setSelection] = useState<{ request?: string; choice: PreviewChoice | null }>({ choice: null });
  const request = props.params.viewRequest;
  const choice =
    request !== selection.request && props.params.requestedView === "screen"
      ? { kind: "screen" as const }
      : selection.choice;
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const listener = props.api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => listener.dispose();
  }, [props.api]);
  return pane && visible ? (
    <PreviewTabContent
      key={request}
      subshellId={pane.subshellId}
      choice={choice}
      onViewChange={(next) => setSelection({ request, choice: next })}
    />
  ) : null;
}
