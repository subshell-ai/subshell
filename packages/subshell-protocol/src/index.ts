export {
  type DeviceReport,
  type DeviceRole,
  type DeviceRow,
  describeDevices,
  roleLabel,
  type ViewersState,
} from "./device-roles.js";
export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type ClientFrame,
  DEVICE_LABEL_MAX,
  normalizeDeviceLabel,
  parseClientFrame,
  type ServerFrame,
  type ViewerPresence,
} from "./frames.js";
export type { JsonValue } from "./json.js";
export {
  type HarnessSessionWire,
  isNodeSubshellId,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeCommandBody,
  type NodeEvent,
  type ProfileDefinitionWire,
  parseNodeCommandBody,
  parseNodeEvent,
} from "./node-frames.js";
export {
  FS_LS_MAX_ENTRIES,
  type NodeFsLsResult,
  type NodeLogReadResult,
  type NodePaneSizeResult,
  type NodeProbeEntry,
  type NodeProbeResumeResult,
  type NodePromptDeliverResult,
  type NodeStatDirResult,
  type NodeWriteFileResult,
  parseNodeCaptureResult,
  parseNodeFsLsResult,
  parseNodeLogReadResult,
  parseNodePaneSizeResult,
  parseNodeProbeEntries,
  parseNodeProbeResume,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
  parseNodeWriteFileResult,
} from "./node-results.js";
export {
  type CommandClaims,
  type ControlKeyPair,
  generateControlKeys,
  JtiLru,
  NODE_CMD_ISSUER,
  NODE_CMD_TTL_SEC,
  SeqTracker,
  type SignCommandInput,
  signCommand,
  /** @internal test-only export (see node-signing.ts) */
  signRawClaims,
  type VerifyContext,
  type VerifyOutcome,
  verifyCommand,
} from "./node-signing.js";
export {
  DEFAULT_DATABASE_PATH,
  defaultSubshellServerDataDir,
  NODE_TARGETS,
  type NodeArtifactsEnv,
  type NodeTarget,
  nodeArtifactFileName,
  resolveNodeArtifactsDir,
  SERVER_TARGETS,
  type ServerTarget,
  serverArtifactFileName,
} from "./paths.js";
export {
  DEFAULT_GRID,
  DEFAULT_SIZING,
  decideSharedGrid,
  type Grid,
  type GridDecision,
  type GridReason,
  MIN_SHARED_COLS,
  MIN_SHARED_ROWS,
  resolveSharedGrid,
  type SizingMode,
  type SizingPolicy,
  type ViewerCapacity,
} from "./shared-geometry.js";
// NOTE: release-artifacts.ts (node: builtins) is intentionally NOT re-exported
// here — this barrel is imported by apps/mobile through Metro, which cannot
// resolve `node:*`. Consumers import "@internal/subshell-protocol/release-artifacts".
export { MAX_UPLOAD_BYTES } from "./uploads.js";
export { agentVersionSupported, MIN_AGENT_VERSION, semverLt } from "./versions.js";
