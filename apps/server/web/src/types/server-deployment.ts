/**
 * Hand-written mirror of `GET /api/admin/server` (spec 2026-09-12 § 3.1) and
 * its two companions, `GET /api/admin/server/logs` and
 * `PUT /api/admin/server/logging` (§ 3.4).
 *
 * Hand-written, like every other file in `src/types/`, because the SPA reads
 * these through `apiFetch` rather than through Eden Treaty: one shape stated
 * here, checked against the route's `t` schema by review, is what the cards
 * and hooks share.
 *
 * The vocabulary split matters on this page: `saved` is what the config file
 * (or the default) says, `running` is what THIS process booted with. They
 * differ after a hand edit over ssh, which is exactly what `restartRequired`
 * exists to say out loud.
 */

/** Where a setting's value came from. `process env` cannot be changed by a file write. */
export type SettingSource = "process env" | "config.env" | "default";

/** One rejected entry within a multi-valued setting (a trusted origin, say). */
export interface SettingProblem {
  /** The entry as written */
  entry: string;
  /** Why it is not usable, in the sentence the CLI prints */
  reason: string;
}

/** One configurable key, as the server sees it. */
export interface ServerSetting {
  /** What config.env (or the built-in default) holds */
  saved: string;
  /** Which rung supplied {@link saved} */
  source: SettingSource;
  /** What the running process actually booted with */
  running: string;
  /** Entries within the value the server refuses to use */
  problems?: SettingProblem[];
}

/** The five keys the deployment view reports, in the order it reports them. */
export type ServerSettingKey = "SERVER_PORT" | "HOST" | "APP_BASE_URL" | "DATABASE_PATH" | "TRUSTED_ORIGINS";

/** Whether restarting this server's process takes its tmux panes down with it. */
export type PaneSafety = "keeps" | "kills" | "unknown";

/** What the platform's service manager says about this server. */
export interface ServiceState {
  /** What supervises the process: a service manager, the desktop app, or null when nothing does */
  manager: "launchd" | "systemd" | "app" | null;
  /** Whether a unit/plist for this server is installed */
  installed: boolean;
  /** Path of that unit/plist, null when not installed */
  definitionPath: string | null;
  /** The manager's own word for the state, verbatim */
  state: string;
  /** The pid the manager started, null when it reports none */
  pid: number | null;
  /** Whether the definition starts at login, null when unknown */
  enabled: boolean | null;
  /** Whether a restart keeps running subshells alive */
  paneSafety: PaneSafety;
  /** The manager's log file (macOS), null under systemd */
  logPath: string | null;
  /** The command that shows the manager's log when there is no file */
  logHint: string | null;
  /** True when the manager's pid IS this process — the precondition for self-restart */
  supervised: boolean;
}

/** Whether `POST /api/admin/server/restart` would be accepted, and why not. */
export interface RestartAvailability {
  /** True when this process can restart itself */
  available: boolean;
  /** The sentence to show when it cannot, null when it can */
  reason: string | null;
}

/** The server log file's state and the debug switch governing its level. */
export interface LoggingState {
  /** Effective debug logging: debug level plus HTTP request lines */
  debug: boolean;
  /** Which rung decided it; `process env` makes the switch read-only */
  source: "process env" | "setting" | "default";
  /** The log file being written — the same string as `paths.serverLog` */
  file: string;
  /** Size cap in bytes; the file is replaced rather than rotated when full */
  capBytes: number;
}

/** The resolved `subshell mcp` entrypoint this server hands to harnesses. */
export interface McpEntrypoint {
  /** Program to run */
  command: string;
  /** Its arguments */
  args: string[];
  /** Which rung resolved it */
  source: string;
}

/** `GET /api/admin/server` — how this server is deployed (spec § 3.1). */
export interface ServerDeployment {
  /** The config file this server reads, and whether it is there */
  configEnv: { path: string; exists: boolean };
  /** One entry per configurable key */
  settings: Record<ServerSettingKey, ServerSetting>;
  /** True when any key's `saved` differs from its `running` */
  restartRequired: boolean;
  /** Whether BETTER_AUTH_SECRET is set, and from where. Never the value itself */
  authSecret: { state: "set" | "missing"; source: SettingSource };
  /** Where this server keeps things on disk */
  paths: {
    /** SUBSHELL_SERVER_DATA_DIR as resolved */
    dataDir: string;
    /** The SQLite file */
    database: string;
    /** Directory holding pane logs */
    logsDir: string;
    /** Directory holding published node binaries */
    nodeArtifacts: string;
    /** The server's own capped log file */
    serverLog: string;
  };
  /** What the service manager says (§ 3.3) */
  service: ServiceState;
  /** Whether a self-restart is offered (§ 3.3) */
  restart: RestartAvailability;
  /** The log file and its level policy (§ 3.4) */
  logging: LoggingState;
  /** Resolved tmux binary, null when absent */
  tmuxPath: string | null;
  /** Resolved `subshell mcp` command, null when UNRESOLVED */
  mcp: McpEntrypoint | null;
  /** Why the MCP entrypoint could not be resolved, null when it was */
  mcpError: string | null;
  /** Host OS: `darwin`, `linux`, or whatever the runtime reports */
  platform: string;
  /** When the server assembled this view (ISO) */
  generatedAt: string;
}

/**
 * `PATCH /api/admin/server/config` — every field optional, at least one
 * present. `DATABASE_PATH` is deliberately absent: moving the database from a
 * web page is a footgun with no undo (spec § 3.2).
 */
export interface ServerConfigPatch {
  /** SERVER_PORT */
  port?: number;
  /** HOST, the bind address */
  host?: string;
  /** APP_BASE_URL — also better-auth's passkey rpID */
  baseUrl?: string;
  /** TRUSTED_ORIGINS, one canonical origin per entry */
  trustedOrigins?: string[];
}

/** The config write's answer: the fresh view plus anything it wants to say about it. */
export type ServerConfigUpdate = ServerDeployment & {
  /** Sentences about a saved-but-questionable combination (a LAN bind with a loopback base URL) */
  warnings: string[];
};

/** One parsed line of the server log. */
export interface ServerLogLine {
  /** ISO timestamp, or the raw prefix for a line that was not JSON */
  ts: string;
  /** Log level, or `raw` for a line the server could not parse */
  level: string;
  /** The message text */
  message: string;
  /** Structured context, when the line carried any */
  data?: unknown;
}

/** `GET /api/admin/server/logs?lines=N` (spec § 3.4). */
export interface ServerLogs {
  /** The last N lines, oldest first */
  lines: ServerLogLine[];
  /** The file they were read from */
  file: string;
  /** Its current size in bytes */
  bytes: number;
  /** The cap at which it is replaced */
  capBytes: number;
}
