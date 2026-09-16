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
 *
 * ONE exception, and it is structural rather than a branch on a label: a
 * `network` plugin implements {@link NetworkPlugin} instead of
 * {@link SubshellPlugin}, so the loader picks WHICH members to require by
 * type. A harness drives a thing in a pane; a network plugin connects this
 * host to one network. They share the store, the manifest and the capability
 * vocabulary, and nothing else.
 */
export type PluginType = "agent-harness" | "terminal" | "network";

/** Every {@link PluginType}, for anything that has to iterate or validate them. */
export const PLUGIN_TYPES: readonly PluginType[] = ["agent-harness", "terminal", "network"];

/** The types whose plugins implement {@link SubshellPlugin} and launch panes. */
export const HARNESS_TYPES: readonly PluginType[] = ["agent-harness", "terminal"];

/**
 * True when this type's plugins implement {@link SubshellPlugin}.
 *
 * Takes a plain string, not a {@link PluginType}, because the wire carries
 * manifest data verbatim: a plugin built against a later contract can report a
 * type this binary has never heard of. Answering `false` for an unknown one is
 * the fail-safe direction — an unrecognized plugin stays out of the launch
 * pickers and the detection specs shipped to nodes, rather than being admitted
 * to them by a cast nobody checked.
 */
export function isHarnessType(type: string): boolean {
  return (HARNESS_TYPES as readonly string[]).includes(type);
}

/**
 * What a plugin can DO. The launch pipeline and the UI read this; neither
 * branches on {@link PluginType}.
 *
 * The union is shared across types and the applicable SUBSET is not, so
 * {@link capabilityMismatches} takes the type: a harness claiming `publish`
 * and a network plugin claiming `resume` are both refused at load, for the
 * same reason a claimed-but-unimplemented capability is.
 */
export type PluginCapability =
  // agent-harness / terminal
  | "mcp"
  | "resume"
  | "attention"
  // network
  | "publish"
  | "supervise"
  | "guard"
  // both
  | "settings";

/** Every {@link PluginCapability}, for validation. */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  "mcp",
  "resume",
  "attention",
  "publish",
  "supervise",
  "guard",
  "settings",
];

/** The capabilities a harness plugin may declare. */
export const HARNESS_CAPABILITIES: readonly PluginCapability[] = ["mcp", "resume", "attention", "settings"];

/** The capabilities a network plugin may declare. */
export const NETWORK_CAPABILITIES: readonly PluginCapability[] = ["publish", "supervise", "guard", "settings"];

/** Which capabilities are meaningful for a plugin of this type. */
export function capabilitiesFor(type: PluginType): readonly PluginCapability[] {
  return isHarnessType(type) ? HARNESS_CAPABILITIES : NETWORK_CAPABILITIES;
}

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
  /**
   * One of: string, boolean, number, select, secret.
   *
   * `secret` is WRITE-ONLY and network-only: the host stores it through
   * {@link PluginHost.secrets} rather than in the settings object, reads
   * report only whether one is set, and a plugin never receives the value —
   * it names the secret and the host hydrates it into a process it spawns
   * ({@link SupervisedProcessSpec}). The preset editor does not render this
   * type; a harness declaring one is a bug rather than a second secret store.
   */
  type: "string" | "boolean" | "number" | "select" | "secret";
  /** Choices when type === "select" */
  choices?: string[];
  /** True when the field must be set before the plugin can act */
  required?: boolean;
  /** Placeholder / example, shown in the editor. Never a real credential. */
  placeholder?: string;
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
  /**
   * Runs a command to completion under the host's bounds and reports it.
   *
   * The one way a plugin executes anything. A plugin does not spawn: the host
   * owns the deadline, the environment allowlist (the process's own
   * environment holds the auth secret and the database path, and is never
   * handed over), the PATH a service-run server would otherwise lack, and the
   * output cap. Two refusals throw rather than returning a result, because
   * both are bugs in the plugin rather than outcomes: `argv[0]` that is not an
   * ABSOLUTE path (resolve it with {@link findBinary} — a bare name would
   * resolve against a PATH the plugin cannot see), and `argv[0]` that is
   * `sudo`. The server has no terminal to answer a password prompt, so a
   * privileged command is a copy-paste instruction for the operator and never
   * something this runs.
   *
   * Long-running processes are NOT this: a plugin that needs one describes it
   * ({@link SupervisedProcessSpec}) and the host supervises it.
   * @since apiVersion 2
   */
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /**
   * Write-only credential storage, scoped to this plugin.
   *
   * There is deliberately NO `get`. A plugin that could read a credential
   * could put it in an argv (visible in `ps`), a log line or a hint string;
   * every legitimate consumer is a process the HOST spawns, so the host
   * hydrates the value itself from the name the plugin gives it. Values are
   * stored 0600 under the host's data directory, never in the database and
   * never in a settings row.
   * @since apiVersion 2
   */
  secrets: PluginSecrets;
  /** The operating system this host runs on. */
  readonly platform: PluginPlatform;
  /** The home directory of the user this host runs as. */
  readonly homeDir: string;
}

/** Where a plugin can be driven at all. Mirrors the manifest's `platforms`. */
export type PluginPlatform = "darwin" | "linux";

/** Every {@link PluginPlatform}, for validation. */
export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = ["darwin", "linux"];

/** Options for {@link PluginHost.run}. */
export interface RunOptions {
  /** Deadline in milliseconds. Default 30_000; the host caps it at 10 minutes. */
  timeoutMs?: number;
  /** Called per output line, ANSI already stripped, from both streams interleaved. */
  onLine?: (line: string) => void;
  /**
   * Ends the run early without failing it.
   *
   * What an interactive login needs: `tailscale up` with no key blocks until a
   * human finishes in a browser, having already printed the URL — so the
   * plugin reads the URL off {@link onLine} and aborts, leaving the daemon
   * waiting. An aborted run reports `aborted: true` and whatever was captured.
   */
  signal?: AbortSignal;
  /** Extra environment on top of the host's allowlist. Never overrides PATH. */
  env?: Record<string, string>;
  /** Text to write to stdin. Absent means stdin is /dev/null, so a prompt cannot hang forever. */
  stdin?: string;
}

/** What {@link PluginHost.run} reports. Never throws for a non-zero exit. */
export interface RunResult {
  /** Exit code, or null when the process was signalled or never started. */
  code: number | null;
  /** Captured stdout, ANSI stripped, capped. */
  stdout: string;
  /** Captured stderr, ANSI stripped, capped. */
  stderr: string;
  /** True when the deadline ended it. */
  timedOut: boolean;
  /** True when {@link RunOptions.signal} ended it. */
  aborted: boolean;
}

/** Write-only, per-plugin credential storage. See {@link PluginHost.secrets}. */
export interface PluginSecrets {
  /** Stores (or replaces) a credential under this name. */
  set(name: string, value: string): Promise<void>;
  /** Whether a credential is stored under this name. The only read there is. */
  has(name: string): Promise<boolean>;
  /** Removes it. Absent is not an error. */
  delete(name: string): Promise<void>;
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

/**
 * Where this host stands with one network, as one word.
 *
 * A ladder, not a set: each state is reachable only from the one before it, so
 * a UI can render the next action without knowing which network it is looking
 * at. `unsupported` is deliberately absent — whether a plugin can run on this
 * OS is manifest DATA the host reads without loading plugin code, so a plugin
 * is never asked a question it would have to answer about itself.
 */
export type NetworkState =
  /** The vendor CLI is not on this machine. */
  | "not-installed"
  /** The CLI is here, but its daemon is not running or not reachable. */
  | "daemon-down"
  /** The daemon is running and this OS user may not drive it. */
  | "needs-privilege"
  /** Ready, and not on the network yet. */
  | "needs-login"
  /** On the network; the server is not published on it. */
  | "joined"
  /** On the network and reachable there. */
  | "published";

/** One address this server can be reached at over a network. */
export interface NetworkAddress {
  /** Canonical origin, no path, no trailing slash — what TRUSTED_ORIGINS stores. */
  url: string;
  /** Scheme of {@link url}, split out so nothing has to re-parse it. */
  scheme: "https" | "http";
  /** Where the name comes from, for the UI: "MagicDNS", "NetBird IP", … */
  label: string;
  /**
   * Whether a browser treats this origin as a secure context.
   *
   * `false` is NOT a warning that the traffic is unencrypted — a WireGuard
   * mesh encrypts an http origin end to end. It says what the BROWSER will
   * refuse there: passkeys (WebAuthn), `Secure` cookies, service workers. A
   * person signing in needs to know that before they try, which is why it is
   * a field rather than something inferred from the scheme at each use site.
   */
  secureContext: boolean;
}

/** One thing the operator can do next, rendered verbatim by the UI. */
export interface NetworkHint {
  /** The sentence. Written for a person, not a log. */
  text: string;
  /** A command to copy, when there is one. */
  command?: string;
  /** Where the vendor documents it. */
  docsUrl?: string;
  /**
   * True when {@link command} needs root.
   *
   * The host never runs one of these: it has no terminal to answer a password
   * prompt, and running a package manager under sudo is not what "the server
   * installs it" should mean. The UI renders it to copy instead.
   */
  privileged?: boolean;
}

/** Everything a plugin reports about one network, on every read. */
export interface NetworkStatus {
  /** Where this host stands. */
  state: NetworkState;
  /** Addresses this server is (or would be) reachable at. Empty below `joined`. */
  addresses: NetworkAddress[];
  /** A URL a human finishes a login at. Only meaningful with `needs-login`. */
  loginUrl?: string;
  /** A code to type at {@link loginUrl}, for device flows that use one. */
  loginCode?: string;
  /** What this host is called on this network, for the UI to display. */
  identity?: { network?: string; hostname?: string; version?: string };
  /** What to do next. Rendered in order; empty when there is nothing to say. */
  hints: NetworkHint[];
}

/**
 * What the host tells a plugin on every call.
 *
 * A network plugin holds NO state of its own: it does not remember the port it
 * published on, what its settings were, or whether it holds a credential. All
 * of that is read from here, so a plugin reloaded mid-life behaves identically
 * to one that has been running since boot, and a server port that changed
 * between two calls is simply the new port.
 */
export interface NetworkContext {
  /** The port this server listens on. The publish target and the address port. */
  port: number;
  /** This plugin's non-secret settings, as the host stored them. */
  settings: Record<string, string>;
  /** Which of this plugin's secrets are set. Presence only — never a value. */
  secrets: { has(name: string): boolean };
}

/** The credential a join may carry. Transient: a plugin never stores it. */
export interface JoinInput {
  /**
   * A pre-authentication credential, if the operator pasted one.
   *
   * Absent asks for the interactive flow instead, which a plugin declaring
   * `interactiveLogin` in its manifest answers with a URL.
   */
  credential?: string;
  /** What this machine should be called on the network. Defaults to its hostname. */
  hostname?: string;
}

/** How a join ended. */
export type JoinOutcome = { state: "joined" } | { state: "needs-login"; loginUrl: string; loginCode?: string };

/** What publishing produced, and what the host must now run and guard. */
export interface PublishOutcome {
  /** Where the server is now reachable. At least one, or this was not a publish. */
  addresses: NetworkAddress[];
  /** A long-running process the HOST must supervise for the publish to hold. */
  process?: SupervisedProcessSpec;
  /** A front-door check the HOST must apply to traffic arriving this way. */
  guard?: RequestGuardSpec;
}

/** A publish the plugin declined, with the reason to render. */
export interface PublishRefusal {
  refused: NetworkHint;
}

/**
 * A long-running child the host owns.
 *
 * The plugin describes it and never spawns it, so "disable this plugin" is a
 * real stop rather than a request: the host holds the handle, restarts it with
 * backoff, stops it at shutdown and reports its state. It is also the only way
 * a stored credential reaches a process — the plugin names the secret, the
 * host substitutes it at spawn, and the value exists in neither the plugin's
 * memory nor the command line the plugin wrote.
 */
export interface SupervisedProcessSpec {
  /** ABSOLUTE path, from {@link PluginHost.findBinary}. `sudo` is refused. */
  command: string;
  /** Arguments, with secret placeholders named in {@link secretFileArgs}. */
  args: string[];
  /** Extra environment, merged over the host's allowlist. */
  env?: Record<string, string>;
  /**
   * Flag → secret name. The host writes the secret to a 0600 file and appends
   * `<flag> <path>` to the argv, so the credential is never an argv element
   * and never visible in `ps`.
   */
  secretFileArgs?: Record<string, string>;
  /** Environment variable name → secret name. Hydrated by the host at spawn. */
  secretEnv?: Record<string, string>;
  /** Regex matched against output; a hit flips the host's state to running. */
  readyPattern?: string;
}

/**
 * A check the host applies to requests arriving over this network.
 *
 * The plugin supplies the CONFIGURATION and the host owns the middleware,
 * because verifying an identity assertion decides whether a request reaches
 * the server at all: that belongs in one audited place, mounted ahead of
 * everything, rather than in code a third party shipped. A plugin saying "this
 * hostname's traffic must carry a valid assertion from this issuer" is a
 * declaration the host can honour; a plugin handed each request would be a
 * second authentication system.
 */
export interface RequestGuardSpec {
  /** The only kind the host implements today. */
  kind: "cloudflare-access";
  /** The Host header whose traffic must carry a valid assertion. */
  hostname: string;
  /** `<team>.cloudflareaccess.com` — the issuer and the JWKS host. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
}

/**
 * A plugin that connects this host to one network.
 *
 * The other half of {@link SubshellPlugin}: a harness drives a program in a
 * pane, a network plugin makes this server reachable. It shares the manifest,
 * the store, the install door and the capability vocabulary, and implements a
 * different set of members — which is why the loader picks what to require
 * from the manifest's `type`.
 *
 * **It describes; the host executes.** Every command goes through
 * {@link PluginHost.run}, every long-running process is described rather than
 * spawned, every credential is named rather than held, and the server's own
 * configuration (trusted origins, base URL) is written by the host and never
 * by a plugin. That is what keeps the admin-only, bounded, audited properties
 * of these acts true of code we did not write.
 *
 * Only the first four members are required.
 */
export interface NetworkPlugin {
  /** Which optional members below are meaningful on this plugin. */
  capabilities(): PluginCapability[];
  /**
   * Where this host stands with this network, right now.
   *
   * Called on every page load and before every act, so it must be cheap and
   * must never throw: an unreachable daemon is `daemon-down` with a hint, not
   * a rejection. It is the plugin's only reporting surface — the host renders
   * what this returns and infers nothing.
   */
  status(ctx: NetworkContext): Promise<NetworkStatus>;
  /** Joins the network, with a pasted credential or by yielding a login URL. */
  join(input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome>;
  /** Leaves it. Best-effort: a machine already off the network is not an error. */
  leave(ctx: NetworkContext): Promise<void>;

  /**
   * Publishes this server on the network. Declare `publish` with it.
   *
   * Returns the addresses plus anything the host must now run or guard, or a
   * {@link PublishRefusal} naming what the operator has to do first — a
   * refusal is an ANSWER rather than a failure, so it carries a hint rather
   * than throwing.
   */
  publish?(ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal>;
  /** Undoes {@link publish}. Declare `publish` with it. */
  unpublish?(ctx: NetworkContext): Promise<void>;
  /**
   * The process the host should be supervising while published, or null.
   * Declare `supervise` with it.
   *
   * Asked again at every boot rather than remembered from the publish, so a
   * rotated credential or a changed port takes effect on the next spawn
   * without anyone re-publishing.
   */
  supervisedProcess?(ctx: NetworkContext): SupervisedProcessSpec | null;
  /**
   * The front-door check the host should be applying while published, or null.
   * Declare `guard` with it. Re-asked at boot, like the process, and installed
   * BEFORE the listener accepts anything.
   */
  requestGuard?(ctx: NetworkContext): RequestGuardSpec | null;
  /** Per-instance configuration fields. Declare `settings` with it. */
  settingsFields?(): SettingsField[];
  /** Field-level problems with a proposed settings write; empty means fine. */
  validateSettings?(values: Record<string, string>): PresetValidationIssue[];
}

/**
 * What a plugin module default-exports.
 *
 * Which of the two shapes it must return is decided by its manifest `type`,
 * and checked by name at load: a `network` plugin returning a harness is
 * refused with the members it is missing, never loaded and left to fail at the
 * first call.
 */
export type PluginFactory = (host: PluginHost) => SubshellPlugin | NetworkPlugin;

/**
 * A factory that returns a harness, for a plugin that knows which it is.
 *
 * {@link PluginFactory} is the LOADER's view — it must accept either shape,
 * because it decides which to expect from the manifest. A plugin itself has no
 * such ambiguity, and annotating its own factory with the union would widen
 * what its tests can call: `createPlugin(host).buildCommand(...)` stops
 * type-checking on a value that might be a network plugin. So a plugin
 * declares the half it implements and the loader keeps the union.
 */
export type HarnessPluginFactory = (host: PluginHost) => SubshellPlugin;

/** A factory that returns a network plugin. See {@link HarnessPluginFactory}. */
export type NetworkPluginFactory = (host: PluginHost) => NetworkPlugin;

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
export function capabilityMismatches(plugin: SubshellPlugin | NetworkPlugin, type: PluginType): string[] {
  const declared = new Set(plugin.capabilities());
  const problems: string[] = [];
  const applicable = capabilitiesFor(type);

  const implemented: Partial<Record<PluginCapability, boolean>> = isHarnessType(type)
    ? (() => {
        const harness = plugin as SubshellPlugin;
        return {
          /** `mcp` covers either dialect: a per-subshell file, or one-time manual steps. */
          mcp: Boolean(harness.mcpRegistration ?? harness.mcpSetup),
          resume: Boolean(harness.resume),
          attention: harness.supportsAttentionHooks === true,
          settings: Boolean(harness.presetSettings),
        };
      })()
    : (() => {
        const network = plugin as NetworkPlugin;
        return {
          /** `publish` is the PAIR: a publish nothing can undo is not a capability. */
          publish: Boolean(network.publish && network.unpublish),
          supervise: Boolean(network.supervisedProcess),
          guard: Boolean(network.requestGuard),
          settings: Boolean(network.settingsFields),
        };
      })();

  /**
   * Whether ANY member of a capability is present, which is a different
   * question from whether the capability is implemented.
   *
   * They differ for `publish` alone, and that gap was a hole: a plugin shipping
   * `publish()` with no `unpublish()` and declaring nothing had
   * `implemented.publish === false`, so neither direction of the check fired
   * and it loaded clean with its publish method permanently unreachable —
   * exactly what the undeclared direction exists to prevent.
   */
  const present: Partial<Record<PluginCapability, boolean>> = isHarnessType(type)
    ? implemented
    : {
        ...implemented,
        publish: Boolean((plugin as NetworkPlugin).publish ?? (plugin as NetworkPlugin).unpublish),
      };

  // A capability that belongs to the OTHER type is refused by name rather than
  // ignored: `resume` on a network plugin is a plugin built against the wrong
  // half of the contract, and silently dropping it would leave whatever it
  // implements unreachable with nothing said.
  for (const capability of declared) {
    if (!applicable.includes(capability)) {
      problems.push(`declares "${capability}", which is not a capability of a ${type} plugin`);
    }
  }

  for (const capability of applicable) {
    if (declared.has(capability) && !implemented[capability]) {
      // Named precisely, because "implements none of its members" is FALSE of
      // a plugin that shipped half a pair and sends its author looking in the
      // wrong place.
      problems.push(
        present[capability]
          ? `declares the "${capability}" capability but implements only part of it (publish and unpublish are a pair: a publish nothing can undo would leave this server exposed with no way back)`
          : `declares the "${capability}" capability but implements none of its members`,
      );
    }
    if (!declared.has(capability) && present[capability]) {
      problems.push(`implements "${capability}" members but does not declare the capability`);
    }
  }
  return problems;
}
