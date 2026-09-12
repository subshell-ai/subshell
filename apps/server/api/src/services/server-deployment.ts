import { homedir } from "node:os";
import { collectStatus, type StatusView } from "@/commands/status.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { APP_BASE_URL, DATABASE_PATH, DEFAULT_TRUSTED_ORIGINS, HOST, SERVER_PORT } from "@/constants.js";
import { DEFAULT_DEPS, queryService, type ServiceState, SYSTEMD_UNIT_NAME } from "@/service.js";
import { currentDebugLogging } from "@/services/logging-preference.js";
import { SERVER_LOG_CAP_BYTES } from "@/utils/log-file.js";

/**
 * The server's view of its OWN deployment (spec 2026-09-12 § 3.1) — how this
 * instance is set up, as against `GET /api/admin/status`, which is what is
 * happening on it. Built from the CLI's `collectStatus` and `queryService`
 * plus the one fact only the running process holds: its own pid.
 */

/** The `configure`-owned keys, in the order the Service page lists them. */
export const DEPLOYMENT_SETTING_KEYS = [
  "SERVER_PORT",
  "HOST",
  "APP_BASE_URL",
  "DATABASE_PATH",
  "TRUSTED_ORIGINS",
] as const;

/** One of the five keys this view reports. */
export type DeploymentSettingKey = (typeof DEPLOYMENT_SETTING_KEYS)[number];

/** Where a setting's SAVED value comes from. */
export type SettingSource = "process env" | "config.env" | "default";

/** One setting, as saved versus as running. */
export interface DeploymentSetting {
  /** What config.env (or the built-in default) says now. */
  saved: string;
  /** Which layer `saved` came from; `process env` means the file cannot change it. */
  source: SettingSource;
  /** What THIS process booted with. */
  running: string;
  /** Diagnostics the CLI's `status` attaches to the saved value, verbatim. Absent when clean, never `[]`. */
  problems?: { entry: string; reason: string }[];
}

/** The service manager's view plus the one fact only the running process can add. */
export interface DeploymentService {
  /** `launchd` on darwin, `systemd` on linux, null elsewhere. */
  manager: "launchd" | "systemd" | "app" | null;
  /** Whether a unit/plist exists on disk. */
  installed: boolean;
  /** Where that definition lives, or would. */
  definitionPath: string | null;
  /** The manager's word for the process state, verbatim. */
  state: string;
  /** The manager's main pid, when it reports one. */
  pid: number | null;
  /** Whether it starts at login. */
  enabled: boolean | null;
  /** Whether stopping keeps live panes. */
  paneSafety: "keeps" | "kills" | "unknown";
  /** The launchd log file; null under systemd (the journal). */
  logPath: string | null;
  /** The command that reads the journal when `logPath` is null. */
  logHint: string | null;
  /** Whether exiting this process is a restart (the manager started it and will respawn it). */
  supervised: boolean;
}

/** Debug logging: whether it is on, and whether the switch is the operator's to flip. */
export interface DeploymentLogging {
  /** Effective state: debug-level lines and HTTP request lines in the log file. */
  debug: boolean;
  /** `process env` means `SUBSHELL_DEBUG_LOGGING` forces it and the setting is read-only. */
  source: "process env" | "setting" | "default";
  /** The log file the toggle governs. */
  file: string;
  /** Size at which that file is replaced. */
  capBytes: number;
}

/** `GET /api/admin/server` — how this server is deployed (spec § 3.1). */
export interface DeploymentView {
  /** The config file's resolved path, and whether it is there. */
  configEnv: { path: string; exists: boolean };
  /** The five `configure`-owned keys, saved versus running. */
  settings: Record<DeploymentSettingKey, DeploymentSetting>;
  /** True when any saved value differs from the running one, so a restart would change behaviour. */
  restartRequired: boolean;
  /** Presence and layer only — never the value. */
  authSecret: { state: "set" | "missing"; source: SettingSource };
  /** The absolute locations this instance's data lives at. */
  paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string; serverLog: string };
  /** What the service manager reports, plus whether exiting here is a restart. */
  service: DeploymentService;
  /** Whether `POST /api/admin/server/restart` would work, and why not when it would not. */
  restart: { available: boolean; reason: string | null };
  /** § 3.4: the effective debug state, where it comes from, and the file it writes. */
  logging: DeploymentLogging;
  /** Absolute path to tmux, or null when it is not on PATH. */
  tmuxPath: string | null;
  /** The resolved `subshell mcp` entrypoint, or null. */
  mcp: { command: string; args: string[]; source: string } | null;
  /** Why the MCP entrypoint did not resolve; null when it did. */
  mcpError: string | null;
  /** `process.platform`. */
  platform: string;
  /** ISO 8601 snapshot time. */
  generatedAt: string;
}

/** Injectable seams; production passes nothing. */
export interface DeploymentDeps {
  /** Runtime platform (production: `process.platform`). */
  platform?: NodeJS.Platform;
  /** Home directory, for the service definition's path (production: `homedir()`). */
  home?: string;
  /** This process's pid (production: `process.pid`). */
  pid?: number;
  /** Env source for the source attribution and the running origin list (production: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Which keys the config.env loader applied (production: `configEnvAppliedKeys()`). */
  applied?: ReadonlySet<string>;
  /** config.env's parsed contents, for the source attribution (production: `resolveConfig().values`). */
  configValues?: Record<string, string>;
  /** The service manager query (production: a real `queryService`, which spawns systemctl/launchctl). */
  queryService?: () => ServiceState;
  /** The CLI's status view (production: `collectStatus`). */
  status?: () => StatusView;
  /** The debug-logging state (production: `currentDebugLogging`). */
  debugLogging?: () => { debug: boolean; source: DeploymentLogging["source"] };
  /** This process's PARENT pid, which {@link appSupervised} checks the claim against (production: `process.ppid`). */
  ppid?: number;
  /** Whether the desktop app runs this process (production: {@link appSupervised} over env + ppid). */
  appSupervised?: () => boolean;
}

/**
 * Whether exiting is a restart: the manager says the unit is running AND the
 * pid it reports is this process. `bun run start`, a terminal, a container
 * with no init: all false, and the route says so instead of exiting into
 * nothing.
 *
 * A stronger fact than a marker in the environment, which is why it is asked
 * this way: the unit and plist templates set only `PATH`, so the process
 * cannot see its own manager from its environment — but it can compare pids
 * with the manager's own answer.
 */
export function isSupervised(service: Pick<ServiceState, "state" | "pid">, pid: number): boolean {
  return service.state === "running" && service.pid === pid;
}

/**
 * Which layer a setting's saved value comes from — and, because the PATCH
 * route refuses `process env`, really the question "would writing this key to
 * config.env take effect at the next boot?"
 *
 * Three rules, in order:
 *
 * 1. A key the loader APPLIED is the file's, even though it now sits in
 *    `process.env`: applying it is what put it there.
 * 2. A key the environment already held at process start, whose value the
 *    file also names, is STILL the file's. That is not a curiosity, it is the
 *    systemd deployment: the unit carries
 *    `EnvironmentFile=<configDir>/config.env`, so every key arrives through
 *    the environment, the loader applies nothing, and rule 1 alone would call
 *    the whole file read-only on the one platform it is most used on — while
 *    systemd re-reads that same file on the next start, so a write plainly
 *    does take effect. `collectStatus` already attributes it this way.
 * 3. Anything else in the environment genuinely overrides the file, and a
 *    write to it would be masked at the next boot.
 *
 * @param file - config.env's parsed contents; omit when there is no file to compare against
 */
export function settingSource(
  key: string,
  env: NodeJS.ProcessEnv,
  applied: ReadonlySet<string>,
  file: Record<string, string> = {},
): SettingSource {
  if (applied.has(key)) return "config.env";
  if (env[key] !== undefined) return file[key] === env[key] ? "config.env" : "process env";
  return file[key] !== undefined ? "config.env" : "default";
}

/** Why a self-restart is impossible when nothing supervises this process. */
const RESTART_UNSUPERVISED_REASON =
  "This server is not running under a service manager; restart it where you started it.";

/** The value THIS process booted with, per key, from the same constants the server runs on. */
function runningValue(key: DeploymentSettingKey, env: NodeJS.ProcessEnv): string {
  switch (key) {
    case "SERVER_PORT":
      return String(SERVER_PORT);
    case "HOST":
      return HOST;
    case "APP_BASE_URL":
      return APP_BASE_URL;
    case "DATABASE_PATH":
      return DATABASE_PATH;
    case "TRUSTED_ORIGINS":
      // The raw key, not the derived allowlist: `saved` is the raw key too,
      // and comparing a stored list against a set that also holds the
      // instance's own origins would report a restart as required forever.
      return env.TRUSTED_ORIGINS ?? DEFAULT_TRUSTED_ORIGINS;
  }
}

/**
 * The `ServiceDeps` this process would use to ask about its own service.
 *
 * Exported because `POST /api/admin/server/autostart` writes through the same
 * seams this view reads through: two constructions of these deps is two
 * chances to disagree about which config dir, which uid, which PATH — and on
 * darwin the config dir is where a not-at-login definition LIVES, so a
 * mismatch would make the route edit a service the view cannot see.
 */
export function serviceDeps(
  opts: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {},
): Parameters<typeof queryService>[0] {
  const env = opts.env ?? process.env;
  return DEFAULT_DEPS({
    platform: opts.platform ?? process.platform,
    home: opts.home ?? homedir(),
    uid: process.getuid?.() ?? 0,
    servicePath: process.execPath,
    argv1: process.argv[1] ?? "",
    configDir: serverConfigDir(),
    env,
    which: (name) => Bun.which(name) ?? null,
    pathEnv: env.PATH,
  });
}

/**
 * The Subshell Server desktop app names itself here when it spawned this
 * process, so the server can report who supervises it (spec 2026-09-12
 * server-supervision § 4.7). Set on the child alongside
 * {@link SUPERVISOR_PID_ENV} and {@link SUPERVISOR_LOG_ENV}.
 */
export const SUPERVISOR_ENV = "SUBSHELL_SUPERVISOR";
/** The supervising process's pid — checked against our own parent, see {@link appSupervised}. */
export const SUPERVISOR_PID_ENV = "SUBSHELL_SUPERVISOR_PID";
/** Where that supervisor is collecting this process's console output. */
export const SUPERVISOR_LOG_ENV = "SUBSHELL_SUPERVISOR_LOG";
/** The only value of {@link SUPERVISOR_ENV} this server recognises. */
export const DESKTOP_SUPERVISOR = "subshell-desktop-server";

/**
 * Whether the Subshell Server app is running this process — a claim in the
 * environment, VERIFIED against our actual parent.
 *
 * The claim alone would be worthless: any process can export a variable. The
 * parentage check means a forged claim only succeeds when the forger really
 * is our parent — a shell that set the variables and exec'd the server — and
 * what that buys is `restart.available: true`, i.e. an admin exiting the
 * server into a parent that will not respawn it. That is an operator lying to
 * themselves on a host they already control, the same class as hand-editing
 * config.env, and it is accepted rather than defended against.
 */
export function appSupervised(env: NodeJS.ProcessEnv, ppid: number): boolean {
  return env[SUPERVISOR_ENV] === DESKTOP_SUPERVISOR && Number(env[SUPERVISOR_PID_ENV]) === ppid;
}

/**
 * Build the whole § 3.1 view. READS ONLY — but not cheap: `collectStatus`
 * probes the port and PATH, and `queryService` spawns the service manager, so
 * this is a polled route's worth of work rather than a hot path's.
 *
 * `saved` and `problems` come from the CLI's own `collectStatus` rather than
 * being recomputed, so the web page and `subshell-server status` cannot
 * disagree about the same host. `source` is computed here instead, from the
 * loader's applied-key set: `status` has to infer the layer by comparing
 * values, and this route's 409 "the environment owns this key" refusal needs
 * the fact rather than the inference.
 */
export function collectDeployment(deps: DeploymentDeps = {}): DeploymentView {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const pid = deps.pid ?? process.pid;
  const env = deps.env ?? process.env;
  const applied = deps.applied ?? configEnvAppliedKeys();
  const configValues = deps.configValues ?? resolveConfig().values;
  const status = (deps.status ?? (() => collectStatus({ platform, home })))();
  const service = (deps.queryService ?? (() => queryService(serviceDeps({ platform, home, env }))))();

  const settings = Object.fromEntries(
    DEPLOYMENT_SETTING_KEYS.map((key) => {
      const found = status.settings[key];
      const problems = found.problems;
      return [
        key,
        {
          saved: found.value,
          source: settingSource(key, env, applied, configValues),
          running: runningValue(key, env),
          ...(problems && problems.length > 0 ? { problems } : {}),
        } satisfies DeploymentSetting,
      ];
    }),
  ) as Record<DeploymentSettingKey, DeploymentSetting>;

  // The app is a supervisor on the same terms a manager is: it respawns this
  // process when it exits (spec § 4.2), which is the only property
  // `restart.available` actually needs. So it reports `supervised: true` and
  // the SPA's Restart button works there unchanged.
  const byApp = (deps.appSupervised ?? (() => appSupervised(env, deps.ppid ?? process.ppid)))();
  const supervised = byApp || isSupervised(service, pid);
  const manager = byApp ? "app" : platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  /** Everything that does not depend on WHO supervises this process. */
  const base = {
    configEnv: status.configEnv,
    settings,
    restartRequired: DEPLOYMENT_SETTING_KEYS.some((key) => settings[key].saved !== settings[key].running),
    authSecret: status.authSecret,
    paths: status.paths,
    logging: {
      ...(deps.debugLogging ?? currentDebugLogging)(),
      file: status.paths.serverLog,
      capBytes: SERVER_LOG_CAP_BYTES,
    },
    tmuxPath: status.tmux,
    mcp: status.mcp,
    mcpError: status.mcpError,
    platform,
    generatedAt: new Date().toISOString(),
  };
  if (byApp) {
    return {
      ...base,
      service: {
        manager: "app",
        // A definition on disk while the app runs this process is a real
        // conflict — two things believe they own the server — so it is named
        // rather than hidden, in the field built for the manager's own words.
        installed: service.installed,
        definitionPath: service.definitionPath,
        state: "running",
        pid,
        // Nothing starts the app's child at login; the app itself starting at
        // login is a different feature, and the switch says so.
        enabled: false,
        // Earned, not assumed: the supervisor signals the main pid only, so a
        // teardown leaves each subshell's tmux server running (spec § 4.2).
        paneSafety: "keeps",
        logPath: env[SUPERVISOR_LOG_ENV] ?? null,
        logHint: null,
        supervised: true,
      },
      restart: { available: true, reason: null },
    };
  }
  return {
    ...base,
    service: {
      manager,
      installed: service.installed,
      definitionPath: service.definitionPath,
      state: service.state,
      pid: service.pid,
      enabled: service.enabled,
      paneSafety: service.paneSafety ?? "unknown",
      logPath: service.logPath ?? null,
      // launchd names a file; per-user systemd logs to the journal, so the
      // command that reads it is the only answer there is.
      logHint: manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT_NAME} -f` : null,
      supervised,
    },
    restart: { available: supervised, reason: supervised ? null : RESTART_UNSUPERVISED_REASON },
  };
}
