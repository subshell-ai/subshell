/**
 * What the SERVER and the AGENT consume, on top of the plugin contract.
 *
 * Everything a plugin itself declares lives in `@subshell-ai/plugin-api` and
 * is re-exported here, deliberately rather than redefined. These were two
 * copies for one commit, and structural typing meant they compiled happily
 * while diverging: `MCP_SERVER_NAME` in particular is baked into every config
 * file the plugins write AND read by the server, so two spellings would show
 * up only as a harness that cannot find its MCP server at runtime.
 *
 * What is genuinely local is {@link HarnessPlugin}, the shape the server and
 * agent still call. `plugin-adapter.ts` is what turns a plugin into one, and
 * both go away when those consumers read plugin descriptors directly.
 */
export {
  type BuildCommandInput,
  type DetectionReason,
  type DetectionResult,
  type HarnessResume,
  MCP_SERVER_NAME,
  type McpLaunchSpec,
  type McpRegistration,
  type McpSetupInfo,
  type McpSetupStep,
  type ProfileDefinition,
  type ProfileValidationIssue,
  type ProfileValidationResult,
  type SettingsField,
} from "@subshell-ai/plugin-api";

import type {
  BuildCommandInput,
  DetectionResult,
  HarnessResume,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  ProfileDefinition,
  ProfileValidationResult,
  SettingsField,
} from "@subshell-ai/plugin-api";

/**
 * Install guidance shown when detection fails.
 *
 * The same shape as the manifest's `install` block, which is where it comes
 * from for every plugin; named separately only because {@link HarnessPlugin}
 * has always called it this.
 */
export interface InstallHint {
  /** Copy-pasteable install command for the official installer */
  command: string;
  /** URL of the installation documentation */
  docsUrl: string;
}

/** Harness plugin interface implemented by every built-in harness. */
export interface HarnessPlugin {
  /** Stable id, e.g. "claude-code" */
  id: string;
  /** Display name, e.g. "Claude Code" */
  name: string;
  /** Executable command name, e.g. "claude" — the same string `findBinary` looks up */
  binaryName: string;
  /** One-line description shown in the UI */
  description: string;
  /** Optional emoji/icon label */
  icon?: string;
  /** Official install instructions, shown when detection fails */
  installHint: InstallHint;
  /** Whether the harness ships enabled out of the box */
  enabledByDefault: boolean;
  /** Whether the harness binary is currently installed/usable. */
  isInstalled(): Promise<boolean>;
  /**
   * Resolves the binary, reporting WHY when there is not one.
   *
   * The reason is what lets a surface tell "install it" apart from "your
   * PLUGIN_PATH is wrong", which are the same `null` to {@link findBinary}.
   */
  detect(): Promise<DetectionResult>;
  /** Resolves the binary path or null if not found. The path-only view of {@link detect}. */
  findBinary(): Promise<string | null>;
  /** Reads the installed version, or null. Resolves the binary itself. */
  getVersion(): Promise<string | null>;
  /**
   * Reads the version of an ALREADY-RESOLVED binary.
   *
   * `getVersion` resolves the binary again, so a caller that has just detected
   * one (every inventory scan) would walk the whole ladder twice per harness.
   * This is the entry point for those callers.
   */
  versionAt(binaryPath: string): Promise<string | null>;
  /** Builds the argv (no shell) used to launch a subshell. */
  buildCommand(input: BuildCommandInput): string[];
  /**
   * Restart-resume support (omit on harnesses that always start a fresh
   * conversation — subshell then never pins an id nor passes resume flags).
   */
  resume?: HarnessResume;
  /**
   * True when `buildCommand` wires this harness's native "needs attention"
   * reporting into the launch (Claude Code: Stop/Notification hooks).
   * The backend's quiet-output idle watcher skips these harnesses.
   */
  supportsAttentionHooks?: boolean;
  /**
   * Renders the per-subshell MCP registration in this harness's native config
   * format (file content + whatever argv/env activates it). Omit the method
   * when the harness cannot consume a per-subshell config file — subshell then
   * surfaces one-time manual setup via mcpSetup() instead.
   */
  mcpRegistration?(launch: McpLaunchSpec, configPath: string): McpRegistration;
  /** How users obtain the subshell MCP tools in this harness (drives the profile UI). */
  mcpSetup(launch: McpLaunchSpec): McpSetupInfo;
  /** Validates a profile definition before saving. */
  validateProfile(profile: ProfileDefinition): ProfileValidationResult;
  /** Settings editor schema (or null if the harness has no settings). */
  settingsFields(): SettingsField[];
  /** Known extra env var suggestions for the profile editor. */
  suggestedEnv(): { key: string; description: string }[];
  /** Known CLI flag suggestions for the profile editor. */
  suggestedFlags(): { flag: string; description: string }[];
  /** Maps a harness exit code to a human label (null = unknown). */
  exitStatus?(code: number): string | null;
}
