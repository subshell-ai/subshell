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
    linger: t.Nullable(t.Boolean(), {
      description:
        "Linux: whether the OS user lingers, so an enabled unit comes back at boot rather than only at login; null on macOS, with nothing installed, and when logind did not answer",
    }),
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

/**
 * `GET /api/admin/server/update` and the two routes that answer with it (spec
 * 2026-09-15 §4.5), here for the same reason the deployment view is: THREE
 * routes render it — the read, the re-check, and `GET /api/admin/updates`,
 * which nests it whole — so stating it once is what keeps them from drifting.
 */

/** One published release, as every view names it. */
export const ReleaseRefSchema = t.Object({
  version: t.String({ description: "Strict X.Y.Z, parsed off the tag" }),
  tag: t.String({ description: "The git tag the release carries (server-v0.7.0)" }),
  publishedAt: t.Nullable(t.String(), {
    description: "ISO 8601 from the release source, or null when it did not say",
  }),
});

/** One database snapshot on disk. */
const BackupFileSchema = t.Object({
  path: t.String({ description: "Absolute path of the snapshot" }),
  bytes: t.Number({ description: "Size in bytes" }),
  at: t.String({ description: "ISO 8601 of the file's mtime — when it was written" }),
});

/** The in-process update job, polled at 1 s while one runs. */
const UpdateJobSchema = t.Object({
  from: t.String({ description: "The version installed when the job started" }),
  to: t.String({ description: "The version being installed" }),
  startedAt: t.String({ description: "ISO 8601, when the job started" }),
  phase: t.Union(
    [
      t.Literal("downloading"),
      t.Literal("verifying"),
      t.Literal("backing-up"),
      t.Literal("swapping"),
      t.Literal("restarting"),
      t.Literal("failed"),
    ],
    { description: "Which step is running; `failed` is terminal and survives until the next start" },
  ),
  received: t.Number({ description: "Bytes downloaded so far; only moves while phase is downloading" }),
  total: t.Nullable(t.Number(), { description: "Total bytes, when the release source sent a content length" }),
  error: t.Nullable(t.String(), { description: "Why the job stopped, when phase is failed" }),
});

/** The transaction that reverted at the last boot, kept until the next update begins. */
const FailedUpdateSchema = t.Object({
  from: t.String({ description: "The version installed before the swap, and restored by the revert" }),
  to: t.String({ description: "The version installed by the swap, which could not boot" }),
  binary: t.String({ description: "The installed binary's path" }),
  previousBinary: t.String({ description: "Where the previous binary was kept while the swap stood" }),
  backup: t.Nullable(t.String(), { description: "The snapshot taken before the swap, or null when there was none" }),
  startedAt: t.String({ description: "ISO 8601, when the swap began" }),
  origin: t.Union([t.Literal("cli"), t.Literal("api"), t.Literal("desktop")], {
    description: "Which surface drove the update",
  }),
  forced: t.Optional(t.Boolean({ description: "Whether the pane-safety refusal was overridden" })),
  error: t.String({ description: "The migration (or boot) error, flattened to a string" }),
  failedAt: t.String({ description: "ISO 8601, when the revert ran" }),
});

/** `GET /api/admin/server/update` — can this server replace itself, and with what. */
export const ServerUpdateViewSchema = t.Object({
  source: t.Object(
    {
      url: t.Nullable(t.String(), { description: "SUBSHELL_RELEASE_URL, or null when it is empty (air-gapped)" }),
      enabled: t.Boolean({ description: "Whether this instance fetches releases at all" }),
    },
    { description: "Where releases are read from" },
  ),
  current: t.String({ description: "The version this process is" }),
  latest: t.Nullable(ReleaseRefSchema, { description: "The newest published server release, or null" }),
  latestError: t.Nullable(t.String(), {
    description: "Why latest is null while the source is on; null when the source answered, or is off",
  }),
  updateAvailable: t.Boolean({ description: "Whether latest is newer than current" }),
  canApply: t.Object(
    {
      ok: t.Boolean({ description: "Whether an update could be applied at all right now" }),
      reasons: t.Array(t.String({ description: "One blocker, in a sentence a page renders verbatim" }), {
        description:
          "Every hard blocker evaluated now — the refusals no press can overcome. Excludes the FORCIBLE pane-safety refusal (see paneSafety) and 'no newer release' (see updateAvailable)",
      }),
    },
    { description: "Whether the button is live, and why not when it is not" },
  ),
  binary: t.Object(
    {
      kind: t.Union([t.Literal("compiled"), t.Literal("source"), t.Literal("unknown")], {
        description: "Which shape the installed server is: one executable, a checkout, or nothing this host can name",
      }),
      path: t.Nullable(t.String(), { description: "The file an update would replace; null unless kind is compiled" }),
      reason: t.Nullable(t.String(), { description: "Why that file cannot be replaced; null when it can" }),
    },
    { description: "Which file an update would replace" },
  ),
  paneSafety: t.Union([t.Literal("keeps"), t.Literal("kills"), t.Literal("unknown")], {
    description:
      "Whether the restart at the end of an update keeps live panes; drives the confirm dialog's sentence and its forced path",
  }),
  job: t.Nullable(UpdateJobSchema, { description: "The running (or last failed) job in this process" }),
  lastFailure: t.Nullable(FailedUpdateSchema, { description: "The last update that reverted at boot" }),
  backups: t.Object(
    {
      dir: t.String({ description: "Where snapshots are written" }),
      keep: t.Number({ description: "How many are kept; 0 = keep forever" }),
      count: t.Number({ description: "How many are there now" }),
      latest: t.Nullable(BackupFileSchema, { description: "The newest snapshot, or null when there is none" }),
    },
    { description: "The backup that would be taken, and what is already there" },
  ),
});
