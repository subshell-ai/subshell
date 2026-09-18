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
  /**
   * Whether `brew` resolves on the login PATH.
   *
   * Only ever asked when {@link tmux} is null, and only on macOS: it decides
   * whether `node_install_tmux` has anything to run here, so a false makes the
   * tmux screen print the manual routes instead of a button that can only
   * refuse.
   */
  hasBrew: boolean;
  paths: NodePaths;
  /**
   * This machine's name, as `hostname(1)` reports it.
   *
   * The reset screen SHOWS this, because the consent gate is deliberate
   * consent rather than a memory test — and `node_reset` compares against the
   * same memoized value, so the page and the gate cannot be two readings of a
   * machine renamed mid-session. Empty means it could not be read, and the
   * reset refuses on that by name.
   */
  hostname: string;
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
 * The app's own preferences. `NodeSettings`.
 *
 * TWO fields. The tray preference used to be here as a trio, because the node
 * page drew a switch for it; it is a check item in the tray menu now (spec
 * 2026-09-12 § 6.4), which is where a preference about the tray belongs, and
 * the fields left with the switch rather than moving to another screen.
 */
export interface NodeSettings {
  /**
   * An explicitly chosen agent binary, if the settings file names one.
   *
   * READ-ONLY from this app as of the picker's removal: `agent_bin::resolve`
   * still honours it and `probe-facts.ts` still shows it, so a hand-edited
   * `settings.json` is supported exactly as before — nothing here writes it.
   */
  agentBinPath: string | null;
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
 * Install tmux with this machine's own package manager.
 *
 * tmux is a hard stop: without it the agent cannot open a pane at all, so an
 * enrolled machine with no tmux is a node that can never run a subshell. Same
 * rule as Subshell Server's own installer — it runs only what a user would
 * have run in a terminal, with their own privileges, and reports the manager's
 * output verbatim.
 *
 * Rejects with a plain string on a platform this app can drive nothing on
 * (macOS without Homebrew, anything that is neither macOS nor Linux); the
 * screen then shows the command to run by hand instead of an error.
 */
export function nodeInstallTmux(): Promise<ActionResult> {
  return invoke<ActionResult>("node_install_tmux");
}

/**
 * Drive one `service` verb.
 *
 * `force` reaches only `restart` — the CLI refuses it elsewhere — and only
 * behind the verbatim refusal it answers, never as a silent retry.
 */
export function nodeService(args: {
  verb: ServiceVerb;
  force: boolean;
  /**
   * `install` only, and omitting it means ARMED.
   *
   * `false` spells `--no-autostart`: install the service and run it now, but
   * do not arm it for login. It is asked once, on the first run's start-up
   * screen; every other caller omits it and keeps the behaviour the agent has
   * always had. The Rust side refuses to pass the flag on any other verb,
   * because the CLI accepts it on `install` alone.
   */
  autostart?: boolean;
}): Promise<ActionResult> {
  return invoke<ActionResult>("node_service", args);
}

/**
 * Repoint this machine's node at a different control plane.
 *
 * The NON-destructive counterpart to {@link nodeEnroll}, and the distinction is
 * the whole reason it exists: no setup key is spent, no second node row is
 * minted, and the node key — whose only home is the 0600 `config.json` — is
 * kept. So there is no confirmation phase; nothing here is unrecoverable.
 *
 * The Rust side also repoints this app's own stored plane address on success,
 * so the two cannot drift (see `lib/plane-coherence.ts` for the drift this
 * closes). The agent reads its config at start, so a repoint takes effect on
 * the next restart of the daemon.
 */
export function nodeConfigure(args: { server: string }): Promise<ActionResult> {
  return invoke<ActionResult>("node_configure", args);
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
  /** REQUIRED: what this machine is called on the plane. `enroll` takes no default. */
  name: string;
  confirm: boolean;
}): Promise<EnrollOutcome> {
  return invoke<EnrollOutcome>("node_enroll", args);
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
 * Show a control plane's own UI in the app's main window, and remember the
 * address.
 *
 * `url` is what the user typed; omit it to open whatever address is already
 * settled. Rejects with a string for anything that is not an http(s) URL, and
 * for "nothing to open" when no address is known yet.
 *
 * **The window this opens is granted exactly one command.** A control plane can
 * live on any host, so its origin cannot be enumerated in a capability file;
 * what it gets instead is `desktop_open_in_browser`, which takes a path and
 * joins it onto that window's own pinned origin — see
 * `src-tauri/src/windows.rs`. Everything privileged stays on this page.
 */
export function nodeOpenPlane(args: { url: string | null }): Promise<string> {
  return invoke<string>("node_open_plane", args);
}

/**
 * Remember a control plane WITHOUT opening its window.
 *
 * The counterpart to {@link nodeOpenPlane}, and the difference is the whole
 * reason it exists: that one persists AND opens, so a first run that used it
 * to record the address the user just typed would throw the dashboard on
 * screen in the middle of setup. This one only persists, and the flow decides
 * when the plane's window is what the person asked for.
 *
 * Returns the canonicalized address — the same normalization `nodeOpenPlane`
 * applies, so the two cannot store two spellings of one plane. Rejects with a
 * string for anything that is not an http(s) URL.
 */
export function nodeSetPlane(args: { url: string }): Promise<string> {
  return invoke<string>("node_set_plane", args);
}

/**
 * Open the settled control-plane address in the SYSTEM browser.
 *
 * No URL argument: the Rust side re-reads the same ladder `nodeOpenPlane`
 * points a window at, so the browser can only be sent to the address this
 * page is already showing. For the sessions the in-app window is wrong for —
 * a different profile, a share, passkeys the webview has no.
 */
export function nodeOpenPlaneUrl(): Promise<void> {
  return invoke<void>("node_open_plane_url");
}

/**
 * Read this machine and stash the reset's delete plan.
 *
 * Changes nothing. Answers whether a plan PARSED — `false` means this machine
 * is not enrolled and the screen renders its own refusal, which is the useful
 * information. The plan is taken here rather than inside {@link nodeReset}
 * because the chain uninstalls the very agent whose `status --json` names
 * those paths.
 */
export function nodeArmReset(): Promise<boolean> {
  return invoke<boolean>("node_arm_reset");
}

/**
 * Return this machine to un-enrolled. IRREVERSIBLE.
 *
 * Stops and uninstalls the node service, closes this node's pane servers, and
 * deletes the data directory, the lock file and `config.json` — the node key's
 * only home. It deletes EXACTLY the stashed plan: the page supplies a
 * hostname, never a path, and a mismatch is refused before anything runs.
 *
 * Deliberately out of reach: the installed `~/.local/bin/subshell`, which the
 * containment guard protects, and the control plane's own node row, which
 * stays behind permanently offline for an admin to remove.
 */
export function nodeReset(args: { typed: string }): Promise<ActionResult> {
  return invoke<ActionResult>("node_reset", args);
}

/**
 * The pages this app may open in the system browser. `WebTarget` in
 * `control.rs` — a closed set there, so the page names a member and Rust
 * decides what that member IS.
 *
 * `macports`, not `mac-ports`: the enum derives kebab-case wire names and
 * `MacPorts` would kebab into a spelling the project does not use, so Rust
 * renames that one variant explicitly. `__tests__/wire-names.test.ts` holds
 * this union equal to what serde will actually accept — the failure it exists
 * for is a runtime `unknown variant` refusal in the window, which no type
 * check can see.
 */
export type WebTarget = "website" | "license" | "company" | "homebrew" | "macports";

/**
 * The event `node_install_tmux` streams the package manager's output on, one
 * line per frame.
 *
 * Emitted to the `node` window alone, which is this page. Named here because
 * the string is the whole of the contract between the command and the tmux
 * screen's progress pane, and `wire-names.test.ts` holds it equal to Rust's
 * `INSTALL_LINE_EVENT`.
 */
export const INSTALL_LINE_EVENT = "node-install-line";

/**
 * `About`. Who made this, under what terms, and where to read more.
 *
 * Every string is Rust's copy of the shared legal constants
 * (`crates/desktop-core/src/legal.rs`), which `scripts/license-fields.ts`
 * holds equal to the TypeScript copy and to the root LICENSE. The page renders
 * them and stores none: a third copy would be one that detector does not
 * cover, and a copyright line that has drifted is invisible.
 *
 * The three URLs are for DISPLAY. Opening one goes through `nodeOpenWeb`,
 * which names a member of a closed set — the page never hands Rust an address.
 */
export interface About {
  productName: string;
  /** This app's own `productName`, e.g. `Subshell Client`. */
  appName: string;
  appVersion: string;
  copyright: string;
  company: string;
  licenseSummary: string;
  websiteUrl: string;
  licenseUrl: string;
  companyUrl: string;
}

/** Ownership, terms and this app's version. Read-only; no machine state. */
/**
 * The screen this window was opened for, taken exactly once.
 *
 * Asked for on mount rather than waited for: the tray's About raises this
 * window and a window that is still loading has no listener yet, so the push
 * it replaces reached nothing. A window that was ALREADY up is still told
 * directly — see `windows::show_node_screen`.
 */
export function nodePendingScreen(): Promise<string | null> {
  return invoke<string | null>("node_pending_screen");
}

export function nodeAbout(): Promise<About> {
  return invoke<About>("node_about");
}

/** Open one of three fixed pages in the SYSTEM browser. A member, never a URL. */
export function nodeOpenWeb(target: WebTarget): Promise<void> {
  return invoke<void>("node_open_web", { target });
}

/**
 * What an app-update check found. `AppUpdateCheck` in `app_update.rs`.
 *
 * `latest` and `reason` are not two ways of saying the same thing. `latest`
 * absent with no `reason` is "this app is the newest published one"; `latest`
 * absent WITH one is "we could not tell, and here is why" — an air-gapped
 * install, a source that would not answer, a release with no manifest for this
 * platform. A screen that flattened the two would say "up to date" to a
 * machine that has not been able to check since it was installed.
 */
export interface AppUpdateCheck {
  /** This app's own version */
  current: string;
  /** The newest published version, only when it is newer than `current` */
  latest: string | null;
  /** The release page, for the "what changed" link */
  notes: string | null;
  /** Why there is no `latest`, when that is not simply "up to date" */
  reason: string | null;
}

/**
 * Ask the project's release list whether a newer **Subshell Client app**
 * exists — the `.app` or the `.deb`, not the node agent it wraps.
 *
 * Downloads nothing and changes nothing. Never rejects for "there is no
 * update": an air-gapped install and an unreachable source arrive as `reason`,
 * because both are ordinary states of a machine and an error banner over
 * either teaches people to ignore the banner.
 */
export function nodeCheckAppUpdate(): Promise<AppUpdateCheck> {
  return invoke<AppUpdateCheck>("node_check_app_update");
}

/**
 * Install the newest app and relaunch into it.
 *
 * **Takes no argument**, which is what lets it be a command at all: the
 * release is re-resolved in Rust, so this page asks for "the newest" and never
 * names a URL. The bytes are refused unless they carry a minisign signature
 * matching the public key compiled into this build.
 *
 * It does not resolve on success — the app restarts. The installed node agent
 * is untouched: this replaces the application, and the agent it bundles is a
 * source to install FROM, on no rung of the resolution ladder.
 */
export function nodeInstallAppUpdate(): Promise<void> {
  return invoke<void>("node_install_app_update");
}
