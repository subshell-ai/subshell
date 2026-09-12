/**
 * The typed edge of the IPC boundary — one function per `desktop_*` command
 * THIS page can invoke.
 *
 * `desktop_open_assistant`, `desktop_shell_ready` and `desktop_notify` are
 * deliberately absent: those three belong to the `main` window, whose page is
 * the SERVER's own SPA and reaches them through its own bridge
 * (`apps/server/web/src/lib/desktop.ts`, which reads `window.__TAURI__`). A
 * wrapper here for a command this page never calls would break the exact-set
 * pin below by describing a surface the assistant does not have.
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
 *    and asserts the set granted to `wizard` is exactly the set this page
 *    invokes, and that `main` still holds exactly its three harmless
 *    commands. A name that appears in only two of the three places is a
 *    runtime permission rejection, not a compile error.
 * 3. The **step union** is derived from `ProbeStep`'s serde values; a step
 *    this build has never heard of is the render path's problem, not a type
 *    error, so the wire type is honest about being a closed set while the
 *    page stays open to one it does not know.
 *
 * `invoke` is imported from `@tauri-apps/api/core` rather than read off
 * `window.__TAURI__`. The global still EXISTS — `withGlobalTauri` is `true`
 * because the `main` window's SPA bridge reads it (`desktop.ts`, pinned by
 * `tauri-config.test.ts` against the UA marker) — but this page takes the
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
  /** `status --json`'s data locations (spec § 8); absent on an older server, which arms nothing. */
  paths?: { dataDir?: string; database?: string; logsDir?: string; nodeArtifacts?: string; serverLog?: string };
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
  /**
   * Who runs the server here, after the disk-wins correction. `service` is a
   * launchd agent or systemd unit; `app` is this app's own child, which lives
   * exactly as long as the app does.
   */
  supervision: "service" | "app";
  /** What this app's own supervisor is doing; null in service mode. */
  supervisor: SupervisorReport | null;
}

/** The app's own child, when it is the one running the server. */
export interface SupervisorReport {
  /** The live child's pid; null between a crash and the respawn. */
  pid: number | null;
  /** One sentence about the last exit; null when nothing has exited. */
  lastExit: string | null;
  /** Where this child's console output is collected. */
  consoleLog: string;
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
 * The address payload `desktop_setup` takes; the Rust side turns empty into
 * omitted flags. A type alias rather than an interface on purpose:
 * `invoke`'s args parameter is a `Record<string, unknown>`, which an
 * interface (no implicit index signature) is not assignable to and an object
 * type is.
 */
export type InitPayload = {
  port: string;
  host: string;
  baseUrl: string;
  trustedOrigins: string;
  /**
   * The two supervision answers, together — they mean nothing apart, and
   * absent is today's chain: a background service armed for login.
   */
  supervision?: { background: boolean; autostart: boolean };
};

/** The `service` verbs the console may drive. `ServiceCommand`, lowercase. */
export type ServiceVerb = "install" | "uninstall" | "start" | "stop" | "restart";

/** The files the console may reveal. `OpenTarget`, kebab-case — a closed set in Rust. */
export type OpenTarget = "config-env" | "server-dir" | "service-definition" | "logs";

/** The three pages About may open. `WebTarget`, kebab-case — a closed set in Rust. */
export type WebTarget = "website" | "license" | "company";

/**
 * `About`. Who made this, under what terms, and where to read more.
 *
 * Every string here is Rust's copy of the shared legal constants
 * (`crates/desktop-core/src/legal.rs`), which `scripts/license-fields.ts`
 * holds equal to the TypeScript copy and to the root LICENSE. The page renders
 * them and stores none: a third copy would be one that detector does not
 * cover, and a copyright line that has drifted is invisible.
 *
 * The three URLs are for DISPLAY. Opening one goes through `openWeb`, which
 * names a member of a closed set — the page never hands Rust an address.
 */
export interface About {
  productName: string;
  /** This app's own `productName`, e.g. `Subshell Server`. */
  appName: string;
  appVersion: string;
  copyright: string;
  company: string;
  licenseSummary: string;
  websiteUrl: string;
  licenseUrl: string;
  companyUrl: string;
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

/** The one destructive verb. Typed hostname in, machine state wiped out; the paths are Rust's plan, never this side's. */
export const reset = (typed: string): Promise<ActionResult> => invoke<ActionResult>("desktop_reset", { typed });

/**
 * Arm the reset screen from the console itself: reads the machine now and
 * stashes the delete plan, exactly as `arm_and_raise` does for the SPA's
 * deep link. Answers whether a plan parsed; the screen renders its own
 * refusal either way, so the caller always proceeds to `showReset()`.
 */
export const armReset = (): Promise<boolean> => invoke<boolean>("desktop_arm_reset");

/**
 * The screen this window was opened for, taken exactly once.
 *
 * Asked for on boot rather than waited for: the push it replaces was emitted
 * from Rust's `on_page_load`, which fires before this page exists, so the
 * event reached a window with nothing listening and the request was lost. A
 * live window is still told directly — see `desktop_pending_screen` in
 * `reset.rs`.
 */
export const pendingScreen = (): Promise<string | null> => invoke<string | null>("desktop_pending_screen");

export const installServer = (): Promise<ActionResult> => invoke<ActionResult>("desktop_install_server");

export const installTmux = (): Promise<ActionResult> => invoke<ActionResult>("desktop_install_tmux");

/** Validated Rust-side; an `Err` (not an `ok:false`) says the file is not a server. */
export const setServerBin = (path: string | null): Promise<void> => invoke<void>("desktop_set_server_bin", { path });

export const openMain = (): Promise<void> => invoke<void>("desktop_open_main");

export const openPath = (target: OpenTarget): Promise<void> => invoke<void>("desktop_open_path", { target });

export const openTmuxDocs = (): Promise<void> => invoke<void>("desktop_open_tmux_docs");

/** Ownership, terms and versions, for the About section. Read-only; no machine state. */
export const about = (): Promise<About> => invoke<About>("desktop_about");

/** Open one of three fixed pages in the SYSTEM browser. A member, never a URL. */
export const openWeb = (target: WebTarget): Promise<void> => invoke<void>("desktop_open_web", { target });
