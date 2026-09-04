/**
 * Shared types for harness plugins. These are consumed by both the backend
 * (registry, subshell runner) and the frontend (profile editor forms).
 */

/** A harness profile as defined by the user (decoded JSON blobs). */
export interface ProfileDefinition {
  /** Human-friendly profile name */
  name: string;
  /** Optional longer description */
  description?: string | null;
  /** Extra environment variables to set on the subshell */
  env: Record<string, string>;
  /** Extra CLI flags to pass to the harness binary */
  flags: string[];
  /** Settings blob passed to the harness (e.g. claude --settings JSON) */
  settings: Record<string, unknown> | null;
  /** If true, only this profile's config sources apply (isolation) */
  configIsolation: boolean;
  /** If true, new subshells from this profile auto-restart on exit */
  restartOnExit?: boolean;
}

/** Snapshot of a single field-level validation error on a profile. */
export interface ProfileValidationIssue {
  /** Field name (e.g. "name", "env", "settings") */
  field: string;
  /** Human-readable problem description */
  message: string;
}

export interface ProfileValidationResult {
  valid: boolean;
  issues: ProfileValidationIssue[];
}

/** Everything a plugin needs to launch a subshell. */
export interface BuildCommandInput {
  /** Resolved absolute path to the harness binary */
  binary: string;
  /** Working directory the harness runs in */
  cwd: string;
  /** The validated profile being used */
  profile: ProfileDefinition;
  /** Subshell display name ("" = let the harness pick a default) */
  subshellName: string;
  /** Any additional CLI flags from route/request context */
  extraFlags?: string[];
  /**
   * The subshell's MCP registration (channels + subshell orchestration), as
   * produced by this plugin's own `mcpRegistration` and already written to
   * disk. Plugins consume ONLY `mcp.args` — splice them where your dialect
   * needs them (claude right after the binary). `mcp.env` is baked into the
   * pane by the backend before your command ever runs; plugins must not
   * consume it themselves. Undefined = no registration for this launch.
   */
  mcp?: McpRegistration;
  /**
   * Conversation identity for restart-resume; set only when this plugin
   * declares a {@link HarnessResume} capability. `mode: "start"` means the
   * conversation is NEW and must be created under exactly this id (pin it —
   * subshell stores the id and later resumes by it); `mode: "resume"` means the
   * id names an EXISTING conversation to continue (the backend only asks
   * after {@link HarnessResume.canResume} confirmed it survives).
   */
  harnessSession?: { id: string; mode: "start" | "resume" };
}

/**
 * Restart-resume capability, implemented only by harnesses that can continue
 * a previous conversation. The ids here are HARNESS conversation ids (e.g. a
 * claude transcript uuid), never subshell ids — the backend pins
 * {@link allocateHarnessSessionId} at launch, stores it on the subshell row
 * as `harness_session_id`, and consults {@link canResume} before every
 * restart to decide between continuing that conversation and starting a
 * fresh one.
 */
export interface HarnessResume {
  /** Allocates the HARNESS conversation id to pin at launch (a uuid for claude). */
  allocateHarnessSessionId(): string;
  /**
   * Whether the harness conversation `harnessSessionId` (last run in `cwd`)
   * still exists and can be resumed. False → the backend launches a fresh
   * conversation instead of handing the harness an id it would reject.
   */
  canResume(harnessSessionId: string, cwd: string): boolean;
}

/** How to spawn the `subshell mcp` stdio server — the shape the backend's `resolveMcpLaunch()` produces. */
export interface McpLaunchSpec {
  /** Executable to run — the self command (`subshell-server mcp`), the interpreter, or the agent binary */
  command: string;
  /** Arguments for the executable (e.g. the mcp entry script path) */
  args: string[];
}

/** Per-subshell MCP registration rendered in the harness's own config dialect. */
export interface McpRegistration {
  /** File content the harness reads, written to the subshell's config path */
  fileContent: string;
  /** argv the harness needs to load the file (e.g. claude's ["--mcp-config", path]) */
  args?: string[];
  /**
   * Extra pane env the harness needs to discover the file (e.g. OPENCODE_CONFIG).
   * Consumed by the BACKEND (baked into the pane env, beating profile env);
   * plugins never read it back.
   */
  env?: Record<string, string>;
}

/** One copy-paste line shown in the profile editor for manual setup harnesses. */
export interface McpSetupStep {
  /** What the user should do / where the text goes */
  label: string;
  /** Copyable command or snippet */
  command: string;
}

/**
 * How a harness gets the `subshell mcp` tools (channels + subshell orchestration).
 * Discriminated on purpose: auto harnesses explain themselves in one line,
 * manual harnesses carry steps — a plugin cannot mix the two.
 */
export type McpSetupInfo = { mode: "auto"; summary: string } | { mode: "manual"; steps: McpSetupStep[] };

/** A single option in the harness's settings editor. */
export interface SettingsField {
  /** JSON pointer-ish key into the settings object (e.g. "permissionMode") */
  key: string;
  /** Property label */
  label: string;
  /** Short description for the editor */
  description?: string;
  /** One of: string, boolean, number, select */
  type: "string" | "boolean" | "number" | "select";
  /** Choices when type === "select" */
  choices?: string[];
  /** Default value when unset */
  default?: string | boolean | number;
}

/** How to install a harness when it is missing. */
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
  /** Whether this harness needs an interactive TTY (almost always true) */
  ttyRequired: boolean;
  /** Whether the harness ships enabled out of the box */
  enabledByDefault: boolean;
  /** Whether the harness binary is currently installed/usable. */
  isInstalled(): Promise<boolean>;
  /** Resolves the binary path or null if not found. */
  findBinary(): Promise<string | null>;
  /** Reads the installed version, or null. */
  getVersion(): Promise<string | null>;
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

/**
 * The MCP server name every harness registers the built-in `subshell mcp`
 * server under — the `mcpServers`/`mcp` config object key and the
 * `hermes mcp add|remove` argument alike. The server itself reports the same
 * name in its MCP handshake (`@internal/mcp-core` server.ts), which is what
 * harnesses surface in wire tool ids (`mcp__<name>__<tool>`).
 */
export const MCP_SERVER_NAME = "subshell";
