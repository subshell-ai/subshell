import { type StartBridgeArgs, startBridge as startRuntimeBridge } from "@internal/pane-runtime";
import { log } from "../log.js";

export type {
  BridgeDeps,
  BridgeFetchResponse,
  BridgeWs,
  PreviewClosedEvent,
  PreviewStreamEvent,
  StartBridgeArgs,
} from "@internal/pane-runtime";
export {
  BRIDGE_HANDSHAKE_BUDGET_MS,
  BRIDGE_LIST_FAMILY_BUDGET_MS,
  bridgeCloseAll,
  bridgeCount,
  clampFps,
  stopBridge,
} from "@internal/pane-runtime";
export function startBridge(args: StartBridgeArgs) {
  return startRuntimeBridge({ ...args, log: args.log ?? log });
}
