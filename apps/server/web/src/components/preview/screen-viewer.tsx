import type { NodePreviewScreenWire } from "@internal/subshell-protocol";
import { VncScreenViewer, type VncScreenViewerProps } from "./vnc-screen-viewer";

export { LOST_LINK_LINE, SCREEN_CLOSE_LINES } from "./vnc-screen-viewer";

export interface ScreenViewerProps extends VncScreenViewerProps {
  /** The provider's viewer protocol; only implemented protocols may be rendered. */
  protocol: NodePreviewScreenWire["viewer"]["protocol"];
}

/** Dispatch by viewer protocol; display providers do not choose React components. */
export function ScreenViewer({ protocol, ...props }: ScreenViewerProps) {
  switch (protocol) {
    case "vnc":
      return <VncScreenViewer {...props} />;
    default:
      return <p>This display connection is not supported by this client.</p>;
  }
}
