import { type OpenLaneArgs, PreviewForward as RuntimePreviewForward } from "@internal/pane-runtime";
import { log } from "../log.js";

export type { LaneDeps, LaneSocket, LaneTimers, OpenLaneArgs, PreviewLaneEvent } from "@internal/pane-runtime";
export { forwardCount, realTimers, setActivePreviewForward } from "@internal/pane-runtime";
export class PreviewForward extends RuntimePreviewForward {
  override openLane(args: OpenLaneArgs): void {
    super.openLane({ ...args, hooks: { ...args.hooks, log: args.hooks.log ?? log } });
  }
}
