import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { PreviewTabContent } from "@/components/preview/preview-tab-content";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";
import type { DockedPaneParams } from "@/components/workspace-dock/docked-pane";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";

export interface DockedPreviewParams extends DockedPaneParams {
  view: WorkspacePreviewTarget;
}
export function DockedPreview(props: IDockviewPanelProps<DockedPreviewParams>) {
  const { detail, onRemovePane } = useWorkspaceDockContext();
  const pane = detail.panes.find((row) => row.id === props.params.paneId);
  const [maximized, setMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const update = () => setMaximized(props.api.isMaximized());
    const maximize = props.containerApi.onDidMaximizedGroupChange(update);
    const move = props.api.onDidGroupChange(update);
    return () => {
      maximize.dispose();
      move.dispose();
    };
  }, [props.api, props.containerApi]);
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const listener = props.api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => listener.dispose();
  }, [props.api]);
  return pane && visible && props.params.view ? (
    <PreviewTabContent
      workspace={{
        maximized,
        onToggleMaximize: () => (props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize()),
      }}
      subshellId={pane.subshellId}
      choice={props.params.view}
      onClose={() => onRemovePane(props.api.id)}
    />
  ) : null;
}
