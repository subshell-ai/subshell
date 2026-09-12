import { t } from "elysia";

/**
 * The `GET /api/admin/server` response shape (spec 2026-09-12 § 3.1), in its
 * own module because `PATCH /api/admin/server/config` and `PUT
 * /api/admin/server/logging` both answer with it — the same view, after the
 * write, so a caller never has to re-fetch to see what it did.
 */

const SettingSourceSchema = t.Union([t.Literal("process env"), t.Literal("config.env"), t.Literal("default")], {
  description: "Which layer the saved value comes from; `process env` means config.env cannot change it",
});

const DeploymentSettingSchema = t.Object({
  saved: t.String({ description: "What config.env (or the built-in default) says now" }),
  source: SettingSourceSchema,
  running: t.String({ description: "What THIS process booted with" }),
  problems: t.Optional(
    t.Array(
      t.Object({
        entry: t.String({ description: "The offending entry" }),
        reason: t.String({ description: "What a browser will do with it, in one sentence" }),
      }),
      { description: "Diagnostics the CLI's status attaches to the saved value; absent when clean" },
    ),
  ),
});

/** `GET /api/admin/server` — how this server is deployed (spec § 3.1). */
export const DeploymentViewSchema = t.Object({
  configEnv: t.Object({
    path: t.String({ description: "Resolved config.env path" }),
    exists: t.Boolean({ description: "Whether the file is there" }),
  }),
  settings: t.Object(
    {
      SERVER_PORT: DeploymentSettingSchema,
      HOST: DeploymentSettingSchema,
      APP_BASE_URL: DeploymentSettingSchema,
      DATABASE_PATH: DeploymentSettingSchema,
      TRUSTED_ORIGINS: DeploymentSettingSchema,
    },
    { description: "The configure-owned keys, saved versus running" },
  ),
  restartRequired: t.Boolean({ description: "True when any saved value differs from the running one" }),
  authSecret: t.Object({
    state: t.Union([t.Literal("set"), t.Literal("missing")], { description: "Presence only, never the value" }),
    source: SettingSourceSchema,
  }),
  paths: t.Object({
    dataDir: t.String({ description: "Instance data directory" }),
    database: t.String({ description: "SQLite file" }),
    logsDir: t.String({ description: "Pane logs directory" }),
    nodeArtifacts: t.String({ description: "Published node binaries directory" }),
    serverLog: t.String({ description: "The server's own log file (200 KB cap, replaced when full)" }),
  }),
  service: t.Object({
    manager: t.Nullable(t.Union([t.Literal("launchd"), t.Literal("systemd"), t.Literal("app")]), {
      description:
        "What supervises this process: the platform's per-user service manager, `app` when the Subshell Server desktop app runs it as a child, or null",
    }),
    installed: t.Boolean({ description: "Whether a unit/plist exists on disk" }),
    definitionPath: t.Nullable(t.String(), { description: "Where that definition lives, or would" }),
    state: t.String({ description: "The manager's word for the process state, verbatim" }),
    pid: t.Nullable(t.Number(), { description: "The manager's main pid" }),
    enabled: t.Nullable(t.Boolean(), { description: "Whether it starts at login" }),
    paneSafety: t.Union([t.Literal("keeps"), t.Literal("kills"), t.Literal("unknown")], {
      description: "Whether stopping keeps live panes",
    }),
    logPath: t.Nullable(t.String(), { description: "The launchd log file; null under systemd" }),
    logHint: t.Nullable(t.String(), { description: "The journal command when logPath is null" }),
    supervised: t.Boolean({
      description: "Whether this process is the one the manager started, so exiting is a restart",
    }),
  }),
  restart: t.Object({
    available: t.Boolean({ description: "Whether POST /api/admin/server/restart would work" }),
    reason: t.Nullable(t.String(), { description: "Why not, when it would not" }),
  }),
  logging: t.Object({
    debug: t.Boolean({ description: "Whether debug logging (and with it HTTP request logging) is on" }),
    source: t.Union([t.Literal("process env"), t.Literal("setting"), t.Literal("default")], {
      description: "Where the effective value comes from; process env means the switch is read-only",
    }),
    file: t.String({ description: "The log file the toggle governs" }),
    capBytes: t.Number({ description: "Size at which the file is replaced" }),
  }),
  tmuxPath: t.Nullable(t.String(), { description: "Absolute path to tmux, or null" }),
  mcp: t.Nullable(
    t.Object({
      command: t.String({ description: "MCP entrypoint command" }),
      args: t.Array(t.String({ description: "Argument" }), { description: "MCP entrypoint args" }),
      source: t.String({ description: "Which rung resolved it" }),
    }),
    { description: "The resolved subshell mcp entrypoint" },
  ),
  mcpError: t.Nullable(t.String(), { description: "Why the MCP entrypoint did not resolve" }),
  platform: t.String({ description: "process.platform" }),
  generatedAt: t.String({ description: "ISO 8601 snapshot time" }),
});
