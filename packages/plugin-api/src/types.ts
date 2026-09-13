/**
 * The contract a Subshell plugin implements.
 *
 * A plugin is loaded from disk by a compiled binary, which means it CANNOT
 * import anything of ours at runtime. Measured on bun 1.4.2: a bare specifier
 * from a plugin file fails to resolve, because there is no `node_modules`
 * beside it. Everything a plugin needs therefore arrives through
 * {@link PluginHost}, handed to the factory it default-exports.
 *
 * This package is types plus PURE helpers only. A plugin bundles it in at
 * build time, so anything with runtime behaviour would freeze at the version
 * the plugin was built against; a filesystem probe that did that would keep
 * searching last year's install locations forever. Those belong on the host.
 */

/**
 * What kind of thing a plugin provides.
 *
 * For humans: it groups and labels in the UI and filters the catalog. Code
 * branches on {@link PluginCapability} instead, so adding a type here touches
 * labels while adding a capability touches the launch pipeline.
 */
export type PluginType = "agent-harness" | "terminal";

/** Every {@link PluginType}, for anything that has to iterate or validate them. */
export const PLUGIN_TYPES: readonly PluginType[] = ["agent-harness", "terminal"];

/**
 * What a plugin can DO. The launch pipeline and the UI read this; neither
 * branches on {@link PluginType}.
 */
export type PluginCapability = "mcp" | "resume" | "attention" | "settings";

/** Every {@link PluginCapability}, for validation. */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = ["mcp", "resume", "attention", "settings"];

/** A harness preset as defined by the user (decoded JSON blobs). */
export interface PresetDefinition {
  /** Human-friendly preset name */
  name: string;
  /** Optional longer description */
  description?: string | null;
  /** Extra environment variables to set on the subshell */
  env: Record<string, string>;
  /** Extra CLI flags to pass to the harness binary */
  flags: string[];
  /** Settings blob passed to the harness (e.g. claude --settings JSON) */
  settings: Record<string, unknown> | null;
  /** If true, only this preset's config sources apply (isolation) */
  configIsolation: boolean;
  /** If true, new subshells from this preset auto-restart on exit */
  restartOnExit?: boolean;
}

/** Snapshot of a single field-level validation error on a preset. */
export interface PresetValidationIssue {
  /** Field name (e.g. "name", "env", "settings") */
  field: string;
  /** Human-readable problem description */
  message: string;
}

export interface PresetValidationResult {
  valid: boolean;
  issues: PresetValidationIssue[];
}

/** Everything a plugin needs to build a launch command. */
export interface BuildCommandInput {
  /** Resolved absolute path to the harness binary */
  binary: string;
  /** Working directory the harness runs in */
  cwd: string;
  /** The validated preset being used */
  preset: PresetDefinition;
  /** Subshell display name ("" = let the harness pick a default) */
  subshellName: string;
  /** Any additional CLI flags from route/request context */
  extraFlags?: string[];
  /**
   * The subshell's MCP registration (channels + subshell orchestration), as
   * produced by this plugin's own `mcpRegistration` and already written to
   * disk. Plugins consume ONLY `mcp.args`: splice them where the dialect needs
   * them (claude right after the binary). `mcp.env` is baked into the pane by
   * the host before the command runs; plugins must not consume it themselves.
   * Undefined = no registration for this launch.
   */
  mcp?: McpRegistration;
  /**
   * Conversation identity for restart-resume; set only when this plugin
   * declares the `resume` capability. `mode: "start"` means the conversation
   * is NEW and must be created under exactly this id (pin it, because the host
   * stores it and later resumes by it); `mode: "resume"` names an EXISTING
   * conversation to continue (the host only asks after {@link HarnessResume.resumePath}
   * pointed at a file the host found there).
   */
  harnessSession?: { id: string; mode: "start" | "resume" };
  /**
   * How a harness hook re-enters the subshell binary on the PANE's machine, as
   * the host resolved it for that machine: `{ command, args }` with the
   * reporting subcommand already appended, so a plugin adds only its own verb
   * words. Splice it into whatever hook mechanism the harness has.
   *
   * A hook runs where the pane runs, and the only program guaranteed to exist
   * there is the binary that launched the pane — which is why this arrives
   * from the host rather than being a command a plugin writes for itself. The
   * hooks here were once `bun -e '<inlined JS>'`, and every machine without a
   * bun on its PATH (i.e. most of them) opened its harness on
   * `bun: command not found`.
   *
   * Undefined means the host could not resolve one. OMIT the hooks then: a
   * command the pane cannot run costs the same signal and adds an error to
   * every session.
   */
  reporter?: ReporterSpec;
}

/**
 * A command prefix that re-enters the subshell binary on a pane's machine,
 * ready for a plugin's own verb words to be appended.
 *
 * Shaped like {@link McpLaunchSpec} and resolved from the same host question
 * ("am I a compiled binary, or is `bun` running my entry script?"), but kept
 * separate because they carry different subcommands and the MCP one is
 * operator-overridable while this one is not.
 */
export interface ReporterSpec {
  /** Executable to run (the binary itself, or the interpreter running it). */
  command: string;
  /** Everything before the plugin's verb words (any entry script, then the subcommand). */
  args: string[];
}

/**
 * Restart-resume, implemented only by plugins that can continue a previous
 * conversation.
 *
 * The ids here are HARNESS conversation ids (a claude transcript uuid, say),
 * never subshell ids: the host pins {@link allocateHarnessSessionId} at launch,
 * stores it on the subshell row, and consults {@link resumePath} before every
 * restart to choose between continuing and starting fresh.
 *
 * Both members are PURE, and that is the load-bearing property (spec
 * 2026-09-10 §5): a resume runs on the CONTROL PLANE, for a pane that lives on
 * a machine the plane cannot see. Computing (rather than checking) is what
 * lets one plugin implementation serve local and remote restarts identically.
 */
export interface HarnessResume {
  /** Allocates the HARNESS conversation id to pin at launch (a uuid for claude). */
  allocateHarnessSessionId(): string;
  /**
   * Where the resumable transcript would be, given the target machine's
   * environment. PURE: it computes a path and never touches a filesystem, so
   * the control plane can build it for a machine it cannot see. The HOST
   * checks existence.
   */
  resumePath(harnessSessionId: string, cwd: string, hostEnv: HostEnv): string;
}

/** The parts of a target machine's environment a plugin may compute against. */
export interface HostEnv {
  /** The node's home directory */
  homeDir: string;
  /** Values for the variables this plugin's manifest declared it needs */
  env: Record<string, string>;
}

/** How to spawn the `subshell mcp` stdio server. */
export interface McpLaunchSpec {
  /** Executable to run (the self command, the interpreter, or the agent binary) */
  command: string;
  /** Arguments for the executable (e.g. the mcp entry script path) */
  args: string[];
}

/** Per-subshell MCP registration rendered in the plugin's own config dialect. */
export interface McpRegistration {
  /** File content the harness reads, written to the subshell's config path */
  fileContent: string;
  /** argv the harness needs to load the file (e.g. claude's ["--mcp-config", path]) */
  args?: string[];
  /**
   * Extra pane env the harness needs to discover the file (e.g. OPENCODE_CONFIG).
   * Consumed by the HOST, which bakes it into the pane env ahead of preset env;
   * plugins never read it back.
   */
  env?: Record<string, string>;
}

/** One copy-paste line shown in the preset editor for manual-setup harnesses. */
export interface McpSetupStep {
  /** What the user should do, and where the text goes */
  label: string;
  /** Copyable command or snippet */
  command: string;
}

/**
 * How a harness obtains the `subshell mcp` tools.
 *
 * Discriminated on purpose: auto harnesses explain themselves in one line and
 * manual harnesses carry steps, and a plugin cannot mix the two.
 */
export type McpSetupInfo = { mode: "auto"; summary: string } | { mode: "manual"; steps: McpSetupStep[] };

/** A single option in a plugin's settings editor. */
export interface SettingsField {
  /** Key into the settings object (e.g. "permissionMode") */
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

/**
 * Why there is no binary.
 *
 * `no-binary` is not a failure: a plugin (a `terminal` one, say) can declare
 * no binary at all, and rendering that as "not on PATH" tells someone their
 * PATH is wrong about something that never wanted one.
 */
export type DetectionReason = "not-on-path" | "override-invalid" | "no-binary";

/** A detection answer: the path, or the reason there is not one. */
export type DetectionResult = { path: string; reason?: undefined } | { path: null; reason: DetectionReason };

/**
 * Everything the host lends a plugin, because a plugin can import none of it.
 *
 * This is also the version boundary: a host at a higher `apiVersion` keeps
 * older plugins working by keeping the fields they were compiled against, so
 * members are ADDED here and never removed or retyped.
 */
export interface PluginHost {
  /** The API version this host implements. Always >= the plugin's own. */
  readonly apiVersion: number;
  /** Resolve a binary through the host's full lookup ladder. */
  findBinary(name: string, envOverride: string, knownPaths: string[]): Promise<string | null>;
  /** The same lookup, reporting why it failed. */
  detectBinary(name: string, envOverride: string, knownPaths: string[]): Promise<DetectionResult>;
  /** Run a short command with a deadline; trimmed stdout, or null. */
  probeVersion(binary: string, args?: string[]): Promise<string | null>;
  /** POSIX-quote one argument for a shell command line. */
  shellQuote(value: string): string;
  /** Structured logging, namespaced to the plugin. */
  log: { debug(message: string): void; warn(message: string): void };
}

/**
 * The plugin itself.
 *
 * Only the first three members are required. Everything else is a capability
 * the plugin opts into and declares from {@link capabilities}, so a `terminal`
 * plugin is a binary and an argv rather than eight stubs.
 */
export interface SubshellPlugin {
  /** Builds the argv (no shell) used to launch a subshell. */
  buildCommand(input: BuildCommandInput): string[];
  /** Validates a preset definition before saving. */
  validatePreset(preset: PresetDefinition): PresetValidationResult;
  /** Which optional members below are meaningful on this plugin. */
  capabilities(): PluginCapability[];

  /** Maps a harness exit code to a human label (null = unknown). */
  exitStatus?(code: number): string | null;
  /**
   * Interprets the raw stdout of the version probe.
   *
   * Probing is the host's job (it owns the deadline); making sense of the
   * output is the plugin's, because only the plugin knows its harness prints
   * a banner rather than a bare semver. Omit it and the trimmed output is
   * used as-is, which is right for every harness that prints just a version.
   */
  parseVersion?(raw: string): string | null;
  /** Overrides manifest-driven detection. Almost no plugin needs this. */
  detect?(): Promise<DetectionResult>;
  /** Restart-resume support. Declare the `resume` capability with it. */
  resume?: HarnessResume;
  /**
   * True when `buildCommand` wires this harness's native "needs attention"
   * reporting into the launch. The host's quiet-output idle watcher skips
   * these. Declare the `attention` capability with it.
   */
  supportsAttentionHooks?: boolean;
  /**
   * Renders the per-subshell MCP registration in this harness's config format.
   * Omit when the harness cannot consume a per-subshell config file; the host
   * then surfaces one-time manual setup via {@link mcpSetup} instead.
   */
  mcpRegistration?(launch: McpLaunchSpec, configPath: string): McpRegistration;
  /** How users obtain the subshell MCP tools here. Declare the `mcp` capability with it. */
  mcpSetup?(launch: McpLaunchSpec): McpSetupInfo;
  /** Settings rendered in the PRESET editor and stored on the preset. */
  presetSettings?(): SettingsField[];
  /** Known extra env var suggestions for the preset editor. */
  suggestedEnv?(): { key: string; description: string }[];
  /** Known CLI flag suggestions for the preset editor. */
  suggestedFlags?(): { flag: string; description: string }[];
}

/** What a plugin module default-exports. */
export type PluginFactory = (host: PluginHost) => SubshellPlugin;

/**
 * The MCP server name every harness registers the built-in `subshell mcp`
 * server under: the config object key, and the `hermes mcp add|remove`
 * argument alike. The server reports the same name in its MCP handshake, which
 * is what harnesses surface in wire tool ids (`mcp__<name>__<tool>`).
 */
export const MCP_SERVER_NAME = "subshell";

/**
 * POSIX-quotes one argument for a shell command line.
 *
 * A pure helper, which is why it may live in the contract: plugins render
 * copy-paste setup commands with it, the host lends the same function through
 * {@link PluginHost}, and a test host that reimplemented it would let a
 * plugin's test assert a form its runtime never produces.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Checks that a plugin's declared capabilities match what it implements.
 *
 * `capabilities()` is what the host branches on, so a declaration that
 * disagrees with the members present is a bug that surfaces late and
 * confusingly: a plugin claiming `resume` without a `resume` object produces a
 * restart that silently starts a fresh conversation instead of continuing one.
 * A plugin implementing something it does not declare is the same problem
 * inverted, and is how a capability quietly stops being read.
 * @param plugin - the object a factory returned
 * @returns one sentence per mismatch; empty when they agree
 */
export function capabilityMismatches(plugin: SubshellPlugin): string[] {
  const declared = new Set(plugin.capabilities());
  const problems: string[] = [];

  /** `mcp` covers either dialect: a per-subshell file, or one-time manual steps. */
  const implemented: Record<PluginCapability, boolean> = {
    mcp: Boolean(plugin.mcpRegistration ?? plugin.mcpSetup),
    resume: Boolean(plugin.resume),
    attention: plugin.supportsAttentionHooks === true,
    settings: Boolean(plugin.presetSettings),
  };

  for (const capability of PLUGIN_CAPABILITIES) {
    if (declared.has(capability) && !implemented[capability]) {
      problems.push(`declares the "${capability}" capability but implements none of its members`);
    }
    if (!declared.has(capability) && implemented[capability]) {
      problems.push(`implements "${capability}" members but does not declare the capability`);
    }
  }
  return problems;
}
