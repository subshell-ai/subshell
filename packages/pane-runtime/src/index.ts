export { validateGenericProfile } from "@subshell-ai/plugin-api";
export {
  type DetectionReason,
  type DetectionResult,
  detectBinary,
  findBinary,
} from "./binary-lookup.js";
export { type BoundedResult, readCommandBounded } from "./bounded-exec.js";
export { builtInIds, type EmbeddedPlugin, readBuiltIn } from "./builtin-source.js";
export { enforceMode } from "./fs-mode.js";
export { type HarnessInventoryEntry, scanHarnesses, scanOne } from "./inventory.js";
export {
  assembleHarnessCommand,
  buildHarnessCommand,
  curatedEnv,
  ENV_KEY_RE,
  validateWorkingDir,
} from "./launch.js";
export {
  DEFAULT_REGISTRY_URL,
  fetchVerifiedTarball,
  type PackageSpec,
  parsePackageSpec,
  type ResolvedVersion,
  resolvePackageVersion,
} from "./npm-registry.js";
export { adaptPlugin } from "./plugin-adapter.js";
export { createPluginHost, type PluginHostOptions } from "./plugin-host.js";
export { buildPluginReports } from "./plugin-report.js";
export {
  type BrokenPlugin,
  createInProcessRuntime,
  type LoadedPlugin,
  type LoadOptions,
  type PluginRuntime,
  resetImportedForTests,
} from "./plugin-runtime.js";
export {
  type InstalledPlugin,
  type InstallRecord,
  installEmbedded,
  installPlugin,
  listInstalled,
  type PluginLog,
  type PluginUpdate,
  pluginsDir,
  type RecoveredInstalls,
  readInstallRecord,
  recoverInterruptedInstalls,
  refreshStaleBuiltIns,
  resetPluginLogForTests,
  resolvePluginUpdates,
  setPluginLog,
  uninstallPlugin,
} from "./plugins-dir.js";
export { prepareInstalledPlugins, seedBuiltIns } from "./plugins-seed.js";
export {
  allHarnesses,
  type BrokenBuiltIn,
  type BrokenInstalled,
  brokenBuiltIns,
  builtInHarnesses,
  clearInstalledPlugins,
  getBuiltInHarness,
  getHarness,
  type InstalledRefresh,
  refreshInstalledPlugins,
  resetRegistryForTests,
} from "./registry.js";
export { shellQuote } from "./shell.js";
export { extractTgz, type TarEntry, type TgzLimits } from "./tar-vendor.js";
export { TmuxRunner, tmuxSocketFor } from "./tmux-runner.js";
export type {
  BuildCommandInput,
  DetectSpec,
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
