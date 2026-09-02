import { t } from "elysia";

/**
 * Shared TypeBox schemas for API responses (documented in OpenAPI).
 */
export const UserInfoSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "Email address" }),
  name: t.String({ description: "Display name" }),
  role: t.String({ description: "Role (admin/user)" }),
});

export const ProfileSchema = t.Object({
  id: t.String({ description: "Profile id" }),
  userId: t.String({ description: "Owning user id" }),
  harnessId: t.String({ description: "Harness plugin id" }),
  name: t.String({ description: "Profile name" }),
  description: t.Union([t.String({ description: "Longer description" }), t.Null()]),
  envJson: t.Union([t.String({ description: "JSON env vars" }), t.Null()]),
  flagsJson: t.Union([t.String({ description: "JSON CLI flags" }), t.Null()]),
  settingsJson: t.Union([t.String({ description: "JSON settings object" }), t.Null()]),
  configIsolation: t.Number({ description: "1 = isolated config sources" }),
  restartOnExit: t.Number({ description: "1 = new sessions auto-restart on exit" }),
  nodeId: t.Nullable(t.String({ description: "Node id this profile is pinned to" }), {
    description: "Pinned launch node id (validated visible at pin time); null = any node",
  }),
  isDefault: t.Number({ description: "1 = auto-seeded default profile (cannot be deleted)" }),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
});

export const SessionSchema = t.Object({
  id: t.String({ description: "Session id" }),
  profileId: t.String({ description: "Profile id" }),
  harnessId: t.String({ description: "Harness plugin id" }),
  nodeId: t.String({ description: "Node the session runs on ('local' = control-plane host)" }),
  name: t.String({ description: "Session display name" }),
  workingDir: t.String({ description: "Absolute working directory" }),
  status: t.String({ description: "running | terminated" }),
  createdAt: t.String({ description: "Created timestamp" }),
  endedAt: t.Union([t.String({ description: "Ended timestamp" }), t.Null()]),
  lastOutputAt: t.Union([t.String({ description: "Last output timestamp (ISO)" }), t.Null()]),
  notes: t.Union([t.String({ description: "Operator note" }), t.Null()]),
  activity: t.Union([t.Literal("active"), t.Literal("idle"), t.Literal("terminated")], {
    description: "Rough activity state",
  }),
  preview: t.Array(t.String({ description: "Recent output preview lines (running sessions only)" })),
  alive: t.Boolean({ description: "True when the pane process is alive; false = crashed/paused" }),
  exitCode: t.Union([t.Number({ description: "Harness exit status" }), t.Null()]),
  startedAt: t.Union([t.String({ description: "Last process start (ISO)" }), t.Null()]),
  backoffCount: t.Number({ description: "Consecutive auto-restarts" }),
  restartOnExit: t.Boolean({ description: "True = auto-restart on exit" }),
  nextRestartAt: t.Union([t.String({ description: "Backoff restart due (ISO)" }), t.Null()]),
  nameLocked: t.Boolean({ description: "True = operator-named; false = pane-title auto-naming owns the name" }),
  notify: t.Boolean({ description: "True = pushes and waiting-for-you priority enabled (bell on)" }),
  waitingSince: t.Union([t.String({ description: "ISO ts of the attention event; null = not waiting" }), t.Null()]),
  access: t.Union([t.Literal("owner"), t.Literal("edit"), t.Literal("view")], {
    description: "Caller's effective access to this session (viewer-relative; never 'none' on a returned row)",
  }),
  terminalReplayLines: t.Nullable(
    t.Number({ description: "Per-session terminal attach history cap (1–200)" }),
  ) /* null = instance default */,
  nodeOffline: t.Boolean({
    description:
      "True when the session's agent node has no live connection — the session may still be running there (spec §5.6); always false for local sessions",
  }),
});

/** Tail of a session's pane log — the diagnostic record of what it printed. */
export const SessionLogTailSchema = t.Object({
  lines: t.Array(t.String({ description: "One captured output line (ANSI stripped)" }), {
    description: "Last lines of the pane log, oldest first; empty when no log exists",
  }),
  truncated: t.Boolean({ description: "True when older output existed but was cut from the response" }),
});

// Shared TypeBox refs for the sharing schemas: reusing one object across the
// response and body keeps the composed `App` type under Elysia's inference
// depth limit (the aggregate router is right at that edge).
/** A sharing permission level (view or edit). */
const SharePermissionSchema = t.Union([t.Literal("view"), t.Literal("edit")], {
  description: "Access level a grant confers",
});
/** A grantee user id or null (the Everyone grant). */
const GranteeIdSchema = t.Nullable(t.String({ description: "Grantee user id" }), {
  description: "Grantee user id, or null for the Everyone grant",
});

/** One sharing grant on a session, with the grantee's display name resolved. */
export const SessionShareSchema = t.Object({
  id: t.String({ description: "Share row id" }),
  granteeUserId: GranteeIdSchema,
  granteeName: t.Nullable(t.String({ description: "Grantee display name" }), {
    description: "Grantee display name ('Everyone' for the null grant; the id when the user is gone)",
  }),
  permission: SharePermissionSchema,
});

/** Response of both the GET and PUT sharing routes: the full current grant set. */
export const SessionSharesResponseSchema = t.Object({
  shares: t.Array(SessionShareSchema, { description: "Every grant currently on the session" }),
});

/** Body of PUT /api/sessions/:id/shares — the complete replacement set. */
export const SetSessionSharesBodySchema = t.Object({
  shares: t.Array(
    t.Object({
      granteeUserId: t.Optional(GranteeIdSchema),
      permission: SharePermissionSchema,
    }),
    { description: "The grants to keep; any prior grant not listed here is removed" },
  ),
});

// The standard API error body lives in src/schema/error.type.ts as
// ApiErrorResponseSchema (single source of truth) — there is deliberately no
// second error schema here.

export const WorkspaceSchema = t.Object({
  id: t.String({ description: "Workspace id" }),
  name: t.String({ description: "Workspace name (unique per user)" }),
  layout: t.Union([t.Any({ description: "Serialized dockview layout tree" }), t.Null()], {
    description: "Saved tiling layout, or null when none has been saved yet",
  }),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
  sessionCount: t.Number({ description: "Number of sessions (panes) the workspace currently holds" }),
});

export const WorkspacePaneSchema = t.Object({
  id: t.String({ description: "Pane id" }),
  sessionId: t.String({ description: "Session rendered in this pane" }),
  sessionName: t.String({ description: "Session display name, joined for the pane title" }),
  sessionStatus: t.Union([t.Literal("running"), t.Literal("terminated")], {
    description: "Lifecycle status of the pane's session",
  }),
  sessionAlive: t.Boolean({ description: "False once the harness process has exited" }),
  sessionExitCode: t.Union([t.Number({ description: "Harness exit status of the pane's session" }), t.Null()]),
  sessionWaitingSince: t.Union([
    t.String({ description: "ISO ts of the attention event that put this session in waiting-for-you state" }),
    t.Null(),
  ]),
  workingDir: t.String({ description: "Absolute working directory of the session" }),
});

export const WorkspaceDetailSchema = t.Object({
  workspace: t.Object(WorkspaceSchema.properties, { description: "The workspace itself" }),
  panes: t.Array(WorkspacePaneSchema, { description: "Panes in this workspace's tiled layout" }),
});

export const HarnessInfoSchema = t.Object({
  id: t.String({ description: "Harness plugin id" }),
  name: t.String({ description: "Display name" }),
  binary: t.String({ description: 'Executable command name, e.g. "claude"' }),
  description: t.String({ description: "One-line description" }),
  icon: t.Optional(t.String({ description: "Icon label" })),
  installed: t.Boolean({ description: "Whether the harness binary is usable" }),
  version: t.Optional(t.String({ description: "Installed version" })),
  enabled: t.Boolean({ description: "Whether the plugin is enabled" }),
  install: t.Object({
    command: t.String({ description: "Official install command" }),
    docsUrl: t.String({ description: "Installation documentation URL" }),
  }),
});

/** One option in a harness's settings editor schema. */
export const SettingsFieldSchema = t.Object({
  key: t.String({ description: "Key into the settings object" }),
  label: t.String({ description: "Property label" }),
  description: t.Optional(t.String({ description: "Short description for the editor" })),
  type: t.Union([t.Literal("string"), t.Literal("boolean"), t.Literal("number"), t.Literal("select")], {
    description: "Editor control kind",
  }),
  choices: t.Optional(t.Array(t.String(), { description: "Choices when type is select" })),
  default: t.Optional(t.Union([t.String(), t.Boolean(), t.Number()], { description: "Default when unset" })),
});

/** A known env var suggestion for the profile editor. */
export const SuggestedEnvSchema = t.Object({
  key: t.String({ description: "Environment variable name" }),
  description: t.String({ description: "What it does" }),
});

/** A known CLI flag suggestion for the profile editor. */
export const SuggestedFlagSchema = t.Object({
  flag: t.String({ description: "Flag as typed, e.g. '--model sonnet'" }),
  description: t.String({ description: "What it does" }),
});

/** One copy-paste step in a harness's manual MCP setup (hermes, pi). */
export const McpSetupStepSchema = t.Object({
  label: t.String({ description: "What the user should do / where it goes" }),
  command: t.String({ description: "Copyable command or JSON snippet" }),
});

/**
 * How this harness obtains the `subshell mcp` cross-session tools. Discriminated:
 * auto harnesses carry only a summary line, manual harnesses only steps —
 * mirrors the harnesses package's McpSetupInfo union.
 */
export const McpSetupSchema = t.Union([
  t.Object({
    mode: t.Literal("auto", { description: "Wired into every subshell session automatically" }),
    summary: t.String({ description: "Human summary for the auto case" }),
  }),
  t.Object({
    mode: t.Literal("manual", { description: "One-time user registration on this machine" }),
    steps: t.Array(McpSetupStepSchema, { description: "Ordered copy-paste steps" }),
  }),
]);

/** Everything the profile editor needs to know about one harness. */
export const HarnessSchemaResponseSchema = t.Object({
  settingsFields: t.Array(SettingsFieldSchema, { description: "Settings editor schema (empty if none)" }),
  suggestedEnv: t.Array(SuggestedEnvSchema, { description: "Known env var suggestions" }),
  suggestedFlags: t.Array(SuggestedFlagSchema, { description: "Known CLI flag suggestions" }),
  mcp: McpSetupSchema,
});
