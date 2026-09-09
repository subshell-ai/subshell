export { validateGenericProfile } from "@subshell-ai/plugin-api";
export {
  type DetectionReason,
  type DetectionResult,
  detectBinary,
} from "./binary-lookup.js";
export { type BoundedResult, readCommandBounded } from "./bounded-exec.js";
export { builtInIds, type EmbeddedPlugin, readBuiltIn } from "./builtin-source.js";
export { type HarnessInventoryEntry, scanHarnesses, scanOne } from "./inventory.js";
export { buildHarnessCommand, curatedEnv, ENV_KEY_RE, validateWorkingDir } from "./launch.js";
export { adaptPlugin } from "./plugin-adapter.js";
export { createPluginHost, type PluginHostOptions } from "./plugin-host.js";
export {
  type BrokenPlugin,
  createInProcessRuntime,
  type LoadedPlugin,
  type LoadOptions,
  type PluginRuntime,
} from "./plugin-runtime.js";
export {
  allHarnesses,
  type BrokenBuiltIn,
  brokenBuiltIns,
  getHarness,
  resetRegistryForTests,
} from "./registry.js";
export { shellQuote } from "./shell.js";
export { TmuxRunner, tmuxSocketFor } from "./tmux-runner.js";
export type {
  BuildCommandInput,
  HarnessPlugin,
  HarnessResume,
  InstallHint,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  McpSetupStep,
  ProfileDefinition,
  ProfileValidationIssue,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
export { MCP_SERVER_NAME } from "./types.js";
export { versionManagerBins } from "./version-manager-paths.js";
export { probeVersion, VERSION_PROBE_TIMEOUT_MS } from "./version-probe.js";
