/**
 * The typed edge of the IPC boundary — one function per `desktop_*` command.
 *
 * Every type below MIRRORS a Rust type in `../src-tauri/src/control.rs` (or,
 * for the ladder types, `server_bin.rs`), which serializes with
 * `#[serde(rename_all = "camelCase")]` on structs and `kebab-case`/`lowercase`
 * on the enums. Three-way agreement is what makes this file worth having:
 *
 * 1. The **shapes** are checked by eye against `control.rs`. Nothing generates
 *    them, so a Rust field rename is a silent `undefined` here — which is why
 *    the fields the console branches on (`next`, `tmux`, `paneSafety`) are the
 *    ones the Rust docblocks spend the most words on.
 * 2. The **command names** are pinned by `__tests__/ipc-acl.test.ts`, which
 *    reads `src-tauri/permissions/desktop.toml` and the two capability files
 *    and asserts the set granted to `console` is exactly the set invoked here,
 *    and that `main` still holds exactly its three harmless commands. A name
 *    that appears in only two of the three places is a runtime permission
 *    rejection, not a compile error.
 * 3. The **step union** is derived from `ProbeStep`'s serde values; a step the
 *    console has never heard of is `fallbackStep()`'s problem, not a type
 *    error, so the wire type is honest about being a closed set while the
 *    render path stays open.
 *
 * `invoke` is imported from `@tauri-apps/api/core` rather than read off
 * `window.__TAURI__`. The global still EXISTS — `withGlobalTauri` is `true`
 * because the `main` window's SPA bridge reads it (`desktop.ts`, pinned by
 * `tauri-config.test.ts` against the UA marker) — but the console takes the
 * typed path and never touches it.
 */
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// The ladder (src-tauri/src/server_bin.rs)
// ---------------------------------------------------------------------------

/** Which rung of the resolution ladder answered. `ServerSource`, kebab-case. */
export type ServerSource = "env" | "configured" | "service" | "local-bin" | "path" | "well-known";

/** What to do about the shipped server versus the installed one. `ServerChoice`, kebab-case. */
export type ServerChoice = "no-bundled" | "install-bundled" | "up-to-date" | "upgrade-available" | "adopt-installed";

/** A resolved server, plus the rung it was found on. `ServerBinary`. */
export interface ServerBinary {
  /** The command PREFIX — one token for a compiled binary, two for a dev-form install. Never a verb. */
  argv: string[];
  source: ServerSource;
  /** `<argv> version` output, when it ran and looked like a version. */
  version: string | null;
}

// ---------------------------------------------------------------------------
// The probe (ProbeStep / Probe in control.rs)
// ---------------------------------------------------------------------------

/** The single next action the console should offer. `ProbeStep`, kebab-case. */
export type ProbeStep = "no-server" | "setup" | "unreachable" | "init" | "install-service" | "start" | "ready";

/** One `{value, source}` entry of `status --json`'s settings, plus its problems. */
export interface SettingEntry {
  value?: string;
  /** "default" means nobody chose it — which decides whether the form sends it. */
  source?: string;
  problems?: { entry: string; reason: string }[];
}

/** `status --json`, forwarded by the Rust side as an opaque `serde_json::Value`. */
export interface StatusBody {
  configEnv?: { path: string; exists: boolean };
  settings?: Record<string, SettingEntry>;
  listen?: { portValid?: boolean; port?: number; portRaw?: string; listening?: boolean };
  /** Absent/null means the entrypoint did not resolve, which 500s every create. */
  mcp?: unknown;
  mcpError?: string;
}

/** `service status --json`, forwarded the same way. Reports the MANAGER's words. */
export interface ServiceBody {
  installed?: boolean;
  /** systemd/launchd state verbatim — `launchd: spawn scheduled` is a real value. */
  state?: string;
  pid?: number | null;
  /** What the manager said, when state alone would misread (crash-throttle). */
  detail?: string | null;
  definitionPath?: string;
  /** Whether a teardown kills live panes. `PaneSafety`: "keeps" | "kills" | "unknown". */
  paneSafety?: string | null;
  /** The plist's log file on macOS; null on Linux (journal); absent on an old server. */
  logPath?: string | null;
}

/**
 * `desktop_probe`. Everything the console decides from, in one round trip.
 * `status`/`service` are the CLI's own bodies and may be an older server's;
 * every field the render reads stays optional-inside optional.
 */
export interface Probe {
  bundledVersion: string | null;
  server: ServerBinary | null;
  managed: boolean;
  status: StatusBody | null;
  service: ServiceBody | null;
  serverChoice: ServerChoice;
  next: ProbeStep;
  /** The CLI's own words when a step FAILED rather than merely being pending. */
  error: string | null;
  /** tmux on the LOGIN PATH, or null. The hard stop on init and service install. */
  tmux: string | null;
  /** The OS in the names `installers.ts` branches on ("linux", "darwin"). */
  platform: string;
  hasBrew: boolean;
  /** Whether setup has reached `ready` here at least once (spec § 4). */
  onboarded: boolean;
  /** The hostname the reset screen shows, types for, and compares (R15). */
  hostname: string;
}

// ---------------------------------------------------------------------------
// Everything else that crosses
// ---------------------------------------------------------------------------

/** Result of anything that changes the machine — the CLI's own words, verbatim. */
export interface ActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The payload `desktop_init` takes; the Rust side turns empty into omitted
 * flags. A type alias rather than an interface on purpose: `invoke`'s args
 * parameter is a `Record<string, unknown>`, which an interface (no implicit
 * index signature) is not assignable to and an object type is.
 */
export type InitPayload = {
  port: string;
  host: string;
  baseUrl: string;
  trustedOrigins: string;
};

/** The `service` verbs the console may drive. `ServiceCommand`, lowercase. */
export type ServiceVerb = "install" | "uninstall" | "start" | "stop" | "restart";

/** The files the console may reveal. `OpenTarget`, kebab-case — a closed set in Rust. */
export type OpenTarget = "config-env" | "server-dir" | "service-definition" | "logs";

/** `DesktopSettings`. Both tray fields come from ONE probe answer by construction. */
export interface DesktopSettings {
  closeToTray: boolean;
  traySupported: boolean;
  trayStatus: "supported" | "not-detected" | "unsupported";
}

/** `LogTail`. An empty tail with a note is the ordinary mid-setup state, not an error. */
export interface LogTail {
  text: string;
  source: string;
  note: string | null;
}

// ---------------------------------------------------------------------------
// One function per command (the set pinned by __tests__/ipc-acl.test.ts)
// ---------------------------------------------------------------------------

export const probe = (): Promise<Probe> => invoke<Probe>("desktop_probe");

export const logs = (): Promise<LogTail> => invoke<LogTail>("desktop_logs");

export const settings = (): Promise<DesktopSettings> => invoke<DesktopSettings>("desktop_settings");

export const setCloseToTray = (enabled: boolean): Promise<void> =>
  invoke<void>("desktop_set_close_to_tray", { enabled });

export const init = (payload: InitPayload): Promise<ActionResult> => invoke<ActionResult>("desktop_init", payload);

export const service = (verb: ServiceVerb, force: boolean): Promise<ActionResult> =>
  invoke<ActionResult>("desktop_service", { verb, force });

/**
 * The one-press chain. The address fields are the wizard's Addresses step;
 * omitting the payload (or every field) is today's derived-defaults run,
 * byte for byte. Empty-string vs absent follows `init_args`' per-field rules,
 * the same contract `desktop_init` gets through `configPayload`.
 */
export const setup = (payload?: InitPayload): Promise<ActionResult> =>
  invoke<ActionResult>("desktop_setup", payload ?? {});

export const installServer = (): Promise<ActionResult> => invoke<ActionResult>("desktop_install_server");

export const installTmux = (): Promise<ActionResult> => invoke<ActionResult>("desktop_install_tmux");

export const installAgent = (id: string): Promise<ActionResult> =>
  invoke<ActionResult>("desktop_install_agent", { id });

/** Validated Rust-side; an `Err` (not an `ok:false`) says the file is not a server. */
export const setServerBin = (path: string | null): Promise<void> => invoke<void>("desktop_set_server_bin", { path });

export const openMain = (): Promise<void> => invoke<void>("desktop_open_main");

export const openPath = (target: OpenTarget): Promise<void> => invoke<void>("desktop_open_path", { target });

export const openControlPlane = (): Promise<void> => invoke<void>("desktop_open_control_plane");

export const openTmuxDocs = (): Promise<void> => invoke<void>("desktop_open_tmux_docs");
