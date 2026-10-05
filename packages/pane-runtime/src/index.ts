/**
 * The plugin contract, re-exported.
 *
 * `@subshell-ai/plugin-api` is a dependency of THIS package, not of the server,
 * which reaches the contract through here exactly as it already does for
 * `SettingsField` and `PresetDefinition`. One edge to the contract, and the
 * server keeps depending on the runtime rather than on both.
 */
export {
  capabilitiesFor,
  HARNESS_CAPABILITIES,
  isDocsUrl,
  isHarnessType,
  type JoinInput,
  type JoinOutcome,
  NETWORK_CAPABILITIES,
  type NetworkAddress,
  type NetworkContext,
  type NetworkHint,
  type NetworkManifest,
  type NetworkPlugin,
  type NetworkState,
  type NetworkStatus,
  PLUGIN_CAPABILITIES,
  PLUGIN_PLATFORMS,
  PLUGIN_TYPES,
  type PluginCapability,
  type PluginPlatform,
  type PluginType,
  type PrivilegedStep,
  type PublishOutcome,
  type PublishRefusal,
  type RequestGuardSpec,
  type RunOptions,
  type RunResult,
  type SubshellManifest,
  type SupervisedProcessSpec,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";
export {
  type DetectionReason,
  type DetectionResult,
  detectBinary,
  findBinary,
} from "./binary-lookup.js";
export { type BoundedResult, readCommandBounded } from "./bounded-exec.js";
export { builtInIds, type EmbeddedPlugin, readBuiltIn } from "./builtin-source.js";
export { exitHookFor } from "./exit-hook.js";
export { enforceMode } from "./fs-mode.js";
export { type HarnessInventoryEntry, scanHarnesses, scanOne } from "./inventory.js";
export {
  assembleHarnessCommand,
  buildHarnessCommand,
  curatedEnv,
  ENV_KEY_RE,
  paneEnvFor,
  validateWorkingDir,
} from "./launch.js";
export { loginPathEntries } from "./login-path.js";
export {
  DEFAULT_REGISTRY_URL,
  fetchVerifiedTarball,
  type PackageSpec,
  parsePackageSpec,
  type ResolvedVersion,
  resolvePackageVersion,
} from "./npm-registry.js";
export {
  appendStdinToLogFile,
  PANE_LOG_FILE_FLAG,
  PANE_LOG_VERB,
} from "./pane-log.js";
export { adaptPlugin } from "./plugin-adapter.js";
export {
  createPluginHost,
  hostPlatform,
  type PluginHostOptions,
  resetPluginDataDirForTests,
  setPluginDataDir,
  withPluginOutput,
} from "./plugin-host.js";
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
  createPluginSecrets,
  pluginSecretsDir,
  pluginStateDir,
  secretPath,
} from "./plugin-secrets.js";
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
  allNetworkPlugins,
  type BrokenBuiltIn,
  type BrokenInstalled,
  brokenBuiltIns,
  builtInHarnesses,
  builtInNetworkPlugins,
  clearInstalledPlugins,
  getBuiltInHarness,
  getHarness,
  getNetworkPlugin,
  type InstalledRefresh,
  type NetworkPluginEntry,
  refreshInstalledPlugins,
  resetRegistryForTests,
} from "./registry.js";
export {
  type BoundedRunOptions,
  type BoundedRunResult,
  CHILD_ENV_KEYS,
  childEnv,
  OUTPUT_CAP,
  runBounded,
} from "./run-bounded.js";
export { shellQuote } from "./shell.js";
export { classifySshFailure, sshTransportFailure } from "./ssh/ssh-diagnose.js";
export {
  defaultSshConfigPath,
  discoverSshAliases,
  isDiscoverableAlias,
  type SshAliasDiscovery,
  type SshConfigWalk,
  type SshHostBlock,
  type SshWalkBudget,
  walkSshConfig,
} from "./ssh/ssh-discover.js";
export {
  buildSshInvocation,
  remoteCommandLine,
  remoteTerminalLine,
  renderSshConfigContents,
  type SshInvocationInput,
  sshChildEnv,
  sshTerminalEnvPairs,
  sshTerminalPaneCommand,
} from "./ssh/ssh-render.js";
export {
  parseProxyHop,
  resolveSshAliasConfig,
  type SshResolutionDeps,
} from "./ssh/ssh-resolve.js";
export {
  reconcileUnsupervisedRuns,
  sweepCompletedRuns,
  sweepSshTerminalState,
} from "./ssh/ssh-retention.js";
export { ensureSshDirs, sshRunsDir } from "./ssh/ssh-run-store.js";
export {
  getSshRunSupervisor,
  peekSshRunSupervisor,
  resetSshSupervisorsForTests,
  type SshRunStartOutcome,
  SshRunSupervisor,
  type SshSupervisedRunRequest,
} from "./ssh/ssh-run-supervisor.js";
export { runSshProcess, type SshProcessResult, sshChildPath } from "./ssh/ssh-spawn.js";
export {
  assertSshTerminalId,
  controlStateFor,
  initTerminalForLaunch,
  readTerminalLog,
  readTerminalState,
  rotateTerminalLogIfNeeded,
  SSH_TERMINAL_LOG_SEGMENT_BYTES,
  type SshControlTransition,
  type SshTerminalLogRead,
  type SshTerminalState,
  terminalLogPath,
  transitionControl,
} from "./ssh/ssh-terminal-log.js";
export { safeTransferPath } from "./tar-blocks.js";
export { type ExtractResult, extractTarGz } from "./tar-extractor.js";
export { extractTgz, type TarEntry, type TgzLimits } from "./tar-vendor.js";
export {
  type ArchiveDir,
  type ArchiveFile,
  type ArchiveLimits,
  type WriteResult,
  writeTarGz,
} from "./tar-writer.js";
export {
  parseSessionLiveness,
  SESSION_LIVENESS_FORMAT,
  TmuxError,
  TmuxRunner,
  TmuxTimeoutError,
  tmuxSocketFor,
  tmuxSocketPath,
} from "./tmux-runner.js";
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
  PresetDefinition,
  PresetValidationIssue,
  PresetValidationResult,
  ReporterSpec,
  SettingsField,
} from "./types.js";
export { MCP_SERVER_NAME } from "./types.js";
export { versionManagerBins } from "./version-manager-paths.js";
export { probeVersion, VERSION_PROBE_TIMEOUT_MS } from "./version-probe.js";
