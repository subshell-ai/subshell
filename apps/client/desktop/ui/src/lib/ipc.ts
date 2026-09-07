/**
 * The typed edge of the IPC boundary — one function per `node_*` command.
 *
 * Every type below MIRRORS a Rust type in `src-tauri/src/control.rs` (or, for
 * the two ladder types, `src-tauri/src/agent_bin.rs`), which serializes with
 * `#[serde(rename_all = "camelCase")]` on structs and `kebab-case`/`lowercase`
 * on the enums. Three-way agreement is what makes this file worth having:
 *
 * 1. The **shapes** are checked by eye against `control.rs`. Nothing generates
 *    them, so a Rust field rename is a silent `undefined` here — which is why
 *    the fields the screens actually branch on (`step`, `paneSafety`,
 *    `requiresConfirmation`, `rewriteTearsDown`) are the ones with the most
 *    words spent on them.
 * 2. The **command names** are pinned by `__tests__/ipc-acl.test.ts`, which
 *    reads `src-tauri/permissions/desktop.toml` and
 *    `src-tauri/capabilities/node.json` and asserts the set granted there is
 *    exactly the set invoked here. A name that appears in only two of the three
 *    places is a runtime permission rejection, not a compile error.
 * 3. The **step union** is derived from `ProbeStep`'s serde values, and
 *    `PROBE_STEPS` in `steps.ts` is the runtime list beside it.
 *
 * `invoke` is imported from `@tauri-apps/api/core` rather than read off
 * `window.__TAURI__`: `withGlobalTauri` is `false` in `tauri.conf.json`, so
 * that global does not exist and the webview carries one fewer ambient handle.
 */
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// The ladder (src-tauri/src/agent_bin.rs)
// ---------------------------------------------------------------------------

/** Which rung of the resolution ladder answered. `AgentSource`, kebab-case. */
export type AgentSource = "env" | "configured" | "service" | "local-bin" | "path" | "well-known";

/** What to do about the shipped agent versus the installed one. `AgentChoice`, kebab-case. */
export type AgentChoice = "no-bundled" | "install-bundled" | "up-to-date" | "upgrade-available" | "adopt-installed";

/** A resolved agent, plus the rung it was found on. `AgentBinary`. */
export interface AgentBinary {
  /** The command PREFIX — one token for a compiled binary, two for a dev-form install. Never a verb. */
  argv: string[];
  source: AgentSource;
  /** `<argv> version` output, when it ran and looked like a version. */
  version: string | null;
}

// ---------------------------------------------------------------------------
// The CLI's own `--json` bodies
// ---------------------------------------------------------------------------

/**
 * `subshell status --json`, forwarded by the Rust side as an opaque
 * `serde_json::Value`.
 *
 * So this interface describes `apps/node/agent/src/cli.ts`'s body, not a Rust
 * struct: `{nodeId, serverUrl, online, agentVersion}` when a config loaded, and
 * `{nodeId: null, serverUrl: null, online: false, agentVersion, reason}` when
 * `loadConfig()` threw. Every field is optional because the app must render
 * against a CLI it may be older than.
 */
export interface NodeStatusBody {
  /** `null` in exactly one case: the config is absent or corrupt. */
  nodeId?: string | null;
  serverUrl?: string | null;
  online?: boolean;
  agentVersion?: string;
  /** Age of the newest daemon heartbeat, present only when a live lock was read. */
  daemonAgeMs?: number;
  /** The CLI's own sentence for why it could not read a config. */
  reason?: string;
}

/** `ServiceRunState` in `apps/node/agent/src/service.ts`. */
export type ServiceRunState = "running" | "stopping" | "stopped" | "not-installed" | "unknown";

/**
 * Whether a teardown leaves live panes running. `PaneSafety` in
 * `apps/node/agent/src/service.ts`.
 *
 * `unknown` is not a shrug — the definition exists and could not be read — so
 * everything here fails CLOSED on it, exactly as the CLI's own guard does.
 * Only a positive `keeps` clears the teardown warnings.
 */
export type PaneSafety = "keeps" | "kills" | "unknown";

/** `subshell service status --json` — `ServiceState` in `apps/node/agent/src/service.ts`. */
export interface ServiceStatusBody {
  installed?: boolean;
  definitionPath?: string | null;
  state?: ServiceRunState;
  pid?: number | null;
  enabled?: boolean | null;
  paneSafety?: PaneSafety | null;
  /** Manager output worth quoting when something answered oddly. */
  detail?: string;
}

/** The `enroll --json` body: never the node key, which the 0600 config file is the only home for. */
export interface EnrolledNodeBody {
  nodeId?: string;
  serverUrl?: string;
  name?: string;
  dataDir?: string;
  configPath?: string;
}

// ---------------------------------------------------------------------------
// The probe (src-tauri/src/control.rs)
// ---------------------------------------------------------------------------

/**
 * The single next thing that has to be true. `ProbeStep`, kebab-case.
 *
 * `no-agent` covers TWO situations — nothing on the ladder answered, and a
 * binary that answered `version` but not `status --json` — because reading the
 * second as "not enrolled" would route a transient read failure to the step
 * that overwrites `config.json`.
 */
export type ProbeStep = "no-agent" | "not-enrolled" | "no-service" | "stopped" | "offline" | "online";

/** The closed set of paths the window may name. `NodePaths`. */
export interface NodePaths {
  configDir: string | null;
  /** 0600, and the node key's only home. */
  configFile: string | null;
  dataDir: string | null;
  /** The agent's log FILE, where the platform has one (macOS). */
  agentLog: string | null;
  /** What to do instead, where it does not (Linux: the `journalctl` line). */
  agentLogHint: string | null;
}

/** Everything the window needs to decide what to offer, in one round trip. `Probe`. */
export interface Probe {
  bundledVersion: string | null;
  agent: AgentBinary | null;
  /** Whether the resolved agent is the copy THIS APP installed and can replace. */
  managed: boolean;
  status: NodeStatusBody | null;
  service: ServiceStatusBody | null;
  agentChoice: AgentChoice;
  step: ProbeStep;
  /** The CLI's own words when a step FAILED rather than merely being pending. */
  error: string | null;
  /** tmux's path on the LOGIN path, or null. */
  tmux: string | null;
  paths: NodePaths;
  /**
   * Whether rewriting the service definition takes the running agent down on
   * the way — true on macOS, because launchd has no reload.
   */
  rewriteTearsDown: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The CLI's own words, verbatim. `ActionResult`.
 *
 * `stdout`/`stderr` are rendered as-is and never re-worded: `apps/node/agent`
 * phrases the tmux refusal, the `loginctl enable-linger` hint, the live-pane
 * refusal and every enrollment failure, and those strings are pinned by its own
 * tests.
 */
export interface ActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** The `service` verbs the page may drive. `ServiceCommand`, lowercase. */
export type ServiceVerb = "install" | "uninstall" | "start" | "stop" | "restart";

/** Why the app is asking before it spends a setup key. `ConfirmKind`, kebab-case. */
export type ConfirmKind = "already-enrolled" | "loopback-server";

/** One thing the user has to acknowledge before `node_enroll` runs. `Confirmation`. */
export interface EnrollConfirmation {
  kind: ConfirmKind;
  message: string;
}

/** What one enrollment attempt produced. `EnrollOutcome`. */
export interface EnrollOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The parsed `enroll --json` body on success. */
  node: EnrolledNodeBody | null;
  /**
   * True when NOTHING was run and no setup key was spent. The caller must
   * render every `confirmations` message and call again with the IDENTICAL
   * arguments plus `confirm: true` — only after an explicit acceptance.
   */
  requiresConfirmation: boolean;
  confirmations: EnrollConfirmation[];
}

/**
 * Whether closing a window to the tray is safe here. `TraySupport`, kebab-case.
 *
 * `not-detected` is a Linux desktop with no StatusNotifier host on the session
 * bus (a stock GNOME, until the AppIndicator extension is installed) — not
 * permanent, and not even certain: the probe cannot see the older XEmbed tray.
 * `unsupported` is a platform with no tray at all.
 */
export type TrayStatus = "supported" | "not-detected" | "unsupported";

/** The app's own preferences. `NodeSettings`. */
export interface NodeSettings {
  agentBinPath: string | null;
  closeToTray: boolean;
  /** Whether the switch is live — the tray probe's answer at this call. */
  traySupported: boolean;
  /** And when it is not, why: the difference between hiding the control and explaining it. */
  trayStatus: TrayStatus;
  /**
   * The control plane this client shows, once one is known — the stored
   * address, else the enrolled node's own `serverUrl`.
   *
   * Resolved on the Rust side rather than assembled here, so what this page
   * offers to open and what {@link nodeOpenPlane} actually opens cannot be two
   * different addresses.
   */
  planeUrl: string | null;
}

/** The directories and files the window may ask to reveal. `OpenTarget`, kebab-case. */
export type OpenTarget = "config-dir" | "data-dir" | "agent-log";

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/**
 * Look at the machine and report what it would take to get this node running.
 *
 * The ONE command that cannot reject: the Rust signature returns `Probe`, not
 * `Result`, and a failed `status`/`service status` is reported inside it as
 * `error` rather than thrown. Two CLI spawns per call, so nothing may call it
 * on a sub-second timer.
 */
export function nodeProbe(): Promise<Probe> {
  return invoke<Probe>("node_probe");
}

/**
 * Read the app's own preferences.
 *
 * One `busctl` spawn on Linux — the tray probe, deliberately re-run on every
 * call rather than memoized, which is what makes the re-check button mean
 * something. Nothing to poll for otherwise; refetched after every action.
 */
export function nodeSettings(): Promise<NodeSettings> {
  return invoke<NodeSettings>("node_settings");
}

/**
 * Materialise the bundled agent at `~/.local/bin/subshell`, stopping the
 * managed service first when it is the binary being replaced.
 *
 * Rejects with a plain string (a Rust `Err`) when the build ships no agent; a
 * downgrade comes back as `ok: false` with the reason on `stderr` instead.
 */
export function nodeInstallAgent(): Promise<ActionResult> {
  return invoke<ActionResult>("node_install_agent");
}

/**
 * Drive one `service` verb.
 *
 * `force` reaches only `restart` — the CLI refuses it elsewhere — and only
 * behind the verbatim refusal it answers, never as a silent retry.
 */
export function nodeService(args: { verb: ServiceVerb; force: boolean }): Promise<ActionResult> {
  return invoke<ActionResult>("node_service", args);
}

/**
 * Register this machine as a node. TWO-PHASE, always.
 *
 * Call with `confirm: false` first. If the outcome says
 * `requiresConfirmation`, nothing was spawned and no setup key was spent —
 * show every message, and call again with the same `server`/`key`/`name` plus
 * `confirm: true` only on an explicit acceptance. A failure AFTER the control
 * plane accepted the key has spent it: the answer is a new key, never a retry.
 */
export function nodeEnroll(args: {
  server: string;
  key: string;
  /** Null means "let the agent default to this machine's hostname". */
  name: string | null;
  confirm: boolean;
}): Promise<EnrollOutcome> {
  return invoke<EnrollOutcome>("node_enroll", args);
}

/**
 * Remember (or forget, with `path: null`) an explicitly chosen agent binary.
 *
 * Rejects with a string for anything that is not an agent — the path is
 * executed on every launch, so the Rust side runs `version` on it first.
 */
export function nodeSetAgentBin(args: { path: string | null }): Promise<void> {
  return invoke<void>("node_set_agent_bin", args);
}

/**
 * Reveal one of a fixed set of the app's own directories or files.
 *
 * Rejects with a string when the platform has no such file — on Linux the
 * rejection for `agent-log` IS the `journalctl` command to run instead, and
 * this is the only place a user learns it, so it must reach the screen.
 */
export function nodeOpenPath(args: { target: OpenTarget }): Promise<void> {
  return invoke<void>("node_open_path", args);
}

/**
 * Choose whether closing the window hides it to the tray.
 *
 * Rejects with a string where no tray was detected — the switch is drawn
 * disabled there, so this is the belt to that braces.
 */
export function nodeSetCloseToTray(args: { enabled: boolean }): Promise<void> {
  return invoke<void>("node_set_close_to_tray", args);
}

/**
 * Show a control plane's own UI in the app's main window, and remember the
 * address.
 *
 * `url` is what the user typed; omit it to open whatever address is already
 * settled. Rejects with a string for anything that is not an http(s) URL, and
 * for "nothing to open" when no address is known yet.
 *
 * **The window this opens is granted no commands.** A control plane can live on
 * any host, so its origin cannot be enumerated in a capability file, and a
 * window that cannot be pinned gets nothing — see
 * `src-tauri/src/windows.rs`. Everything privileged stays on this page.
 */
export function nodeOpenPlane(args: { url: string | null }): Promise<string> {
  return invoke<string>("node_open_plane", args);
}
