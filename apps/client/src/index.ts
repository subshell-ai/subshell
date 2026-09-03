/**
 * Library entry (built by tsdown for type-checked imports); the binary entry
 * is main.ts. Exposes the pieces another tool — or a later-phase test harness
 * — may want without going through the CLI.
 */

export { NODE_CLOSE_SUPERSEDED, NODE_CLOSE_UPDATE_REQUIRED } from "@internal/subshell-protocol";
export { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from "./backoff.js";
export { type AgentConfig, clientHome, configPath, loadConfig, saveConfig } from "./config.js";
export {
  type DaemonDeps,
  HEARTBEAT_MS,
  probeOnline,
  runDaemon,
  type WsConstructor,
  type WsLike,
  wsUrlFor,
} from "./daemon.js";
export { type EnrollOptions, mapOs, type NodeOs, runEnroll } from "./enroll.js";
export { type AgentIdentity, identityPath, loadOrCreateIdentity } from "./identity.js";
export { buildInventoryEvent, type InventoryEvent } from "./inventory.js";
export { clearLock, type DaemonLock, isPidAlive, lockPath, readLock, writeLock } from "./lock.js";
export { runAgentMcp } from "./mcp/main.js";
export { AGENT_VERSION } from "./version.js";
