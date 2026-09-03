export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type ClientFrame,
  parseClientFrame,
  type ServerFrame,
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
  type NodeLogReadResult,
  type NodeProbeEntry,
  type NodeProbeResumeResult,
  type NodePromptDeliverResult,
  type NodeStatDirResult,
  type NodeWriteFileResult,
  parseNodeCaptureResult,
  parseNodeLogReadResult,
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
} from "./paths.js";
// NOTE: release-artifacts.ts (node: builtins) is intentionally NOT re-exported
// here — this barrel is imported by apps/mobile through Metro, which cannot
// resolve `node:*`. Consumers import "@internal/subshell-protocol/release-artifacts".
export { MAX_UPLOAD_BYTES } from "./uploads.js";
