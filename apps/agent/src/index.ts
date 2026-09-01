/**
 * Library entry (built by tsdown for type-checked imports); the binary entry
 * is main.ts. Exposes the pieces another tool — or a later-phase test harness
 * — may want without going through the CLI.
 */
export { type AgentConfig, agentHome, configPath, loadConfig, saveConfig } from "./config.js";
export { type EnrollOptions, mapOs, type NodeOs, runEnroll } from "./enroll.js";
export { type AgentIdentity, identityPath, loadOrCreateIdentity } from "./identity.js";
export { AGENT_VERSION } from "./version.js";
