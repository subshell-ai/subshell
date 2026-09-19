/**
 * Library entry (built by tsdown for type-checked imports); the binary entry
 * is main.ts. Exposes the pieces another tool — or a later-phase test harness
 * — may want without going through the CLI.
 */

export { NODE_CLOSE_SUPERSEDED, NODE_CLOSE_UPDATE_REQUIRED } from "@internal/subshell-protocol";
export { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from "./backoff.js";
export { clientHome, configPath, loadConfig, type NodeConfig, saveConfig } from "./config.js";
export {
  type DaemonDeps,
  HEARTBEAT_MS,
  probeOnline,
  runDaemon,
  type WsConstructor,
  type WsLike,
  wsUrlFor,
} from "./daemon.js";
export { type EnrollOptions, type EnrollResult, mapOs, type NodeOs, runEnroll } from "./enroll.js";
export { identityPath, loadOrCreateIdentity, type NodeIdentity } from "./identity.js";
export { buildInventoryEvent, type InventoryEvent } from "./inventory.js";
export { clearLock, type DaemonLock, isPidAlive, lockPath, readLock, writeLock } from "./lock.js";
export { runNodeMcp } from "./mcp/main.js";
// The `service status --json` vocabulary, so a tool reading that output types
// it instead of restating it. The DRIVERS stay unexported: they only run
// against injected ServiceDeps, and shelling out to `subshell service …` is
// the supported way to reach them.
export {
  isServiceVerb,
  type PaneSafety,
  SERVICE_VERBS,
  type ServiceRunState,
  type ServiceState,
  type ServiceVerb,
} from "./service.js";
export { NODE_VERSION } from "./version.js";
