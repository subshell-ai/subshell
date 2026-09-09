import claudeCodeFactory, { manifest as claudeCodeManifest } from "@subshell-ai/plugin-claude-code";
import { CodexPlugin } from "./codex.js";
import { HermesPlugin } from "./hermes.js";
import { OpencodePlugin } from "./opencode.js";
import { PiPlugin } from "./pi.js";
import { adaptPlugin } from "./plugin-adapter.js";
import { createPluginHost } from "./plugin-host.js";
import type { HarnessPlugin } from "./types.js";

/**
 * Built-in harness registry. New harnesses are added here (static imports
 * only — no dynamic imports, per repo convention).
 */
export const ALL_HARNESSES: HarnessPlugin[] = [
  adaptPlugin(claudeCodeManifest, claudeCodeFactory(createPluginHost({ pluginId: "claude-code" }))),
  new OpencodePlugin(),
  new HermesPlugin(),
  new PiPlugin(),
  new CodexPlugin(),
];

/** The app's display list/registry helper. */
export function getHarness(id: string): HarnessPlugin | undefined {
  return ALL_HARNESSES.find((h) => h.id === id);
}

export { validateGenericProfile } from "@subshell-ai/plugin-api";
export {
  type DetectionReason,
  type DetectionResult,
  detectBinary,
} from "./binary-lookup.js";
export { type BoundedResult, readCommandBounded } from "./bounded-exec.js";
export { CodexPlugin } from "./codex.js";
export { HermesPlugin } from "./hermes.js";
export { type HarnessInventoryEntry, scanHarnesses, scanOne } from "./inventory.js";
export { buildHarnessCommand, curatedEnv, ENV_KEY_RE, validateWorkingDir } from "./launch.js";
export { OpencodePlugin } from "./opencode.js";
export { PiPlugin } from "./pi.js";
export { adaptPlugin } from "./plugin-adapter.js";
export { createPluginHost, type PluginHostOptions } from "./plugin-host.js";
export {
  type BrokenPlugin,
  createInProcessRuntime,
  type LoadedPlugin,
  type LoadOptions,
  type PluginRuntime,
} from "./plugin-runtime.js";
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
