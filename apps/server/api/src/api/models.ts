import { t } from "elysia";
import { VirtualDisplayRequestSchema } from "@/schema/virtual-display.js";

/**
 * One declared port forward as the pane header shows it (spec 2026-10-15):
 * the row exactly as launch approved it, with the nulls the wire carries.
 * The renderer for words lives in the web app, not here. A separate
 * declaration from `ssh-views.ts`'s input envelope on purpose: every schema
 * here joins one exported `App` type, and the expressive input kind-census
 * has already pushed the agent-or-ssh unions in that type past TypeScript's
 * inference-depth edge once (measured the day `forwards` arrived; it is why
 * `SshForwardRowInputSchema` is flat). The view copy stays constraint-light
 * for the same reason. The protocol parser owns the grammar for all of them.
 */
export const SshForwardViewSchema = t.Object({
  kind: t.Union([t.Literal("local"), t.Literal("remote"), t.Literal("dynamic")], {
    description: "-L local, -R remote, or -D dynamic SOCKS",
  }),
  listenPort: t.Number({ description: "Port the forward listens on (1-65535)" }),
  bindHost: t.Nullable(
    t.String({
      description: "Bind address; null = loopback on a local/dynamic row, the destination's policy on a remote one",
    }),
  ),
  targetHost: t.Nullable(
    t.String({ description: "Host reached through the connection; null on a dynamic row, which has no fixed target" }),
  ),
  targetPort: t.Nullable(t.Number({ description: "Target port; null on a dynamic row" })),
});

/**
 * Shared TypeBox schemas for API responses (documented in OpenAPI).
 */
export const UserInfoSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "Email address" }),
  name: t.String({ description: "Display name" }),
  role: t.String({ description: "Role (admin/user)" }),
});

export const PresetSchema = t.Object({
  screenConfig: t.Optional(
    t.Nullable(t.String({ description: "JSON virtual display launch request; null means no display" })),
  ),
  ownerName: t.Optional(t.String({ description: "Preset owner display name" })),
  access: t.Optional(
    t.Union([t.Literal("owner"), t.Literal("edit"), t.Literal("view")], {
      description: "Viewer access; sharing and deletion remain owner-only",
    }),
  ),
  kind: t.Literal("agent", { description: "Agent preset discriminator" }),
  id: t.String({ description: "Preset id" }),
  userId: t.String({ description: "Owning user id" }),
  harnessId: t.String({ description: "Harness plugin id" }),
  name: t.String({ description: "Preset name" }),
  description: t.Union([t.String({ description: "Longer description" }), t.Null()]),
  envJson: t.Union([t.String({ description: "JSON env vars" }), t.Null()]),
  flagsJson: t.Union([t.String({ description: "JSON CLI flags" }), t.Null()]),
  settingsJson: t.Union([t.String({ description: "JSON settings object" }), t.Null()]),
  configIsolation: t.Number({ description: "1 = isolated config sources" }),
  restartOnExit: t.Number({ description: "1 = new subshells auto-restart on exit" }),
  crossCommNotes: t.Optional(t.Nullable(t.String({ description: "User-authored guidance for calling agents" }))),
  crossCommEnabled: t.Number({ description: "1 = cross-subshell comms (MCP) enabled for this preset" }),
  nodeId: t.Nullable(
    t.String({ description: "Default node for launches; null leaves the choice to the caller or server" }),
  ),
  workingDir: t.Nullable(t.String({ description: "Default absolute working directory; null leaves it unset" })),
  promptBlocks: t.Nullable(t.String({ description: "JSON prompt block stack (snapshot bodies; null = no prompt)" })),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
});

export const SubshellSchema = t.Object({
  screen: t.Nullable(VirtualDisplayRequestSchema),
  virtualDisplay: t.Nullable(
    t.String({ description: "The subshell’s known virtual display, or null when none is available" }),
  ),
  id: t.String({ description: "Subshell id" }),
  presetId: t.Nullable(t.String({ description: "Preset launched with (null = presetless launch)" })),
  harnessId: t.String({ description: "Harness plugin id" }),
  nodeId: t.String({ description: "Node the subshell runs on ('local' = control-plane host)" }),
  name: t.String({ description: "Subshell display name" }),
  workingDir: t.String({ description: "Absolute working directory" }),
  status: t.String({ description: "running | terminated" }),
  createdAt: t.String({ description: "Created timestamp" }),
  endedAt: t.Union([t.String({ description: "Ended timestamp" }), t.Null()]),
  lastOutputAt: t.Union([t.String({ description: "Last output timestamp (ISO)" }), t.Null()]),
  activity: t.Union([t.Literal("active"), t.Literal("idle"), t.Literal("terminated")], {
    description: "Rough activity state",
  }),
  preview: t.Array(t.String({ description: "Recent output preview lines (running subshells only)" })),
  alive: t.Boolean({ description: "True when the pane process is alive; false = crashed/paused" }),
  exitCode: t.Union([t.Number({ description: "Harness exit status" }), t.Null()]),
  startedAt: t.Union([t.String({ description: "Last process start (ISO)" }), t.Null()]),
  backoffCount: t.Number({ description: "Consecutive auto-restarts" }),
  restartOnExit: t.Boolean({ description: "True = auto-restart on exit" }),
  nextRestartAt: t.Union([t.String({ description: "Backoff restart due (ISO)" }), t.Null()]),
  nameLocked: t.Boolean({ description: "True = operator-named; false = pane-title auto-naming owns the name" }),
  notify: t.Boolean({ description: "True = pushes and waiting-for-you priority enabled (bell on)" }),
  parentSubshellId: t.Nullable(
    t.String({ description: "Subshell that created this helper; null for human launches or unavailable parents" }),
  ),
  crossAgent: t.Boolean({
    description:
      "True = the pane was launched by an agent over MCP (create_subshell), not a human at the UI: internal cross-agent comms, filed as such in the rail and created with the bell off",
  }),
  waitingSince: t.Union([t.String({ description: "ISO ts of the attention event; null = not waiting" }), t.Null()]),
  unseenPush: t.Boolean({
    description:
      "True = a delivered push the owner has not answered by opening the pane or typing into it (spec 2026-09-23; the typing answer joined 2026-09-25)",
  }),
  access: t.Union([t.Literal("owner"), t.Literal("edit"), t.Literal("view")], {
    description: "Caller's effective access to this subshell (viewer-relative; never 'none' on a returned row)",
  }),
  ssh: t.Boolean({
    description: "True when this pane is an SSH-terminal pane: only its owner can type into it.",
  }),
  sshSummary: t.Optional(
    t.Object(
      {
        destination: t.String({ description: "Canonical user@host:port the pane connected to" }),
        forwards: t.Nullable(t.Array(SshForwardViewSchema, { description: "A declared forward row" }), {
          description:
            "The port forwards declared at launch, in the order added; empty when none; null when the pane's stored rows can't be read, which the header must not render as 'none' (spec 2026-10-15)",
        }),
      },
      {
        description:
          "Bounded view of the SSH connection (canonical destination, declared forward rows) for the pane header. Same disclosure class as the ssh.launch audit summary; absent on a pane whose column can't be read",
      },
    ),
  ),
  nodeOffline: t.Boolean({
    description:
      "True when the subshell's node is disconnected. The subshell may still be running there. Always false for subshells on the server host.",
  }),
  shareCount: t.Number({
    description:
      "How many grants this subshell carries (0 = private to its owner). Drives the UI's disclosure warning: every grantee can read the pane's full output, and an `edit` grantee its keystroke stream",
  }),
  sharedWithViewer: t.Optional(
    t.Boolean({
      description: "True when a non-owner has a direct or Everyone sharing grant",
    }),
  ),
  sharedWithEveryone: t.Boolean({
    description:
      "True when one of the grants is the Everyone grant; the audience is every signed-in user, not a countable list",
  }),
});

/** Tail of a subshell's pane log — the diagnostic record of what it printed. */
export const SubshellLogTailSchema = t.Object({
  lines: t.Array(t.String({ description: "One captured output line (ANSI stripped)" }), {
    description: "Last lines of the pane log, oldest first; empty when no log exists",
  }),
  truncated: t.Boolean({
    description:
      "True when this response is not the whole story: a tail dropped older lines; a cursor read had bytes following in the file, or its last line carried no newline yet (a still-unfinished or over-long line, whose remainder arrives on the next read). The liveness case always says truncated, even at EOF: the flag means the line it ended on was not known-complete",
  }),
  nextByte: t.Number({
    description:
      "Raw log-file offset to pass as from_byte to read only what follows (spec 2026-10-01 §3). A tail read answers EOF, so the cursor seeds where the pane is now; a cursor read answers the end of the last complete line it returned, or the end of the window when it held no newline at all (so the cursor never sticks on a long or still-unfinished line)",
  }),
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

/** One sharing grant on a subshell, with the grantee's display name resolved. */
export const SubshellShareSchema = t.Object({
  id: t.String({ description: "Share row id" }),
  granteeUserId: GranteeIdSchema,
  granteeName: t.Nullable(t.String({ description: "Grantee display name" }), {
    description: "Grantee display name ('Everyone' for the null grant; the id when the user is gone)",
  }),
  permission: SharePermissionSchema,
});

/** Response of both the GET and PUT sharing routes: the full current grant set. */
export const SubshellSharesResponseSchema = t.Object({
  shares: t.Array(SubshellShareSchema, { description: "Every grant currently on the subshell" }),
});

/** Body of PUT /api/subshells/:id/shares — the complete replacement set. */
export const SetSubshellSharesBodySchema = t.Object({
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
  name: t.String({ description: "Workspace name (not unique; every lookup is by id)" }),
  layout: t.Union([t.Any({ description: "Serialized dockview layout tree" }), t.Null()], {
    description: "Saved tiling layout, or null when none has been saved yet",
  }),
  createdAt: t.String({ description: "Created timestamp" }),
  updatedAt: t.String({ description: "Updated timestamp" }),
  subshellCount: t.Number({ description: "Number of subshells (panes) the workspace currently holds" }),
});

export const WorkspacePaneSchema = t.Object({
  id: t.String({ description: "Pane id" }),
  subshellId: t.String({ description: "Subshell rendered in this pane" }),
  subshellName: t.String({ description: "Subshell display name, joined for the pane title" }),
  subshellStatus: t.Union([t.Literal("running"), t.Literal("terminated")], {
    description: "Lifecycle status of the pane's subshell",
  }),
  subshellAlive: t.Boolean({ description: "False once the harness process has exited" }),
  subshellExitCode: t.Union([t.Number({ description: "Harness exit status of the pane's subshell" }), t.Null()]),
  subshellWaitingSince: t.Union([
    t.String({ description: "ISO ts of the attention event that put this subshell in waiting-for-you state" }),
    t.Null(),
  ]),
  workingDir: t.String({ description: "Absolute working directory of the subshell" }),
  subshellNodeId: t.String({
    description: "Node the subshell runs on ('local' = control-plane host)",
  }),
  subshellNodeOffline: t.Boolean({
    description:
      "True when the subshell's node is disconnected. Its process may still be running, but the server can't check it. Always false for subshells on the server host.",
  }),
});

export const WorkspaceDetailSchema = t.Object({
  workspace: t.Object(WorkspaceSchema.properties, { description: "The workspace itself" }),
  panes: t.Array(WorkspacePaneSchema, { description: "Panes in this workspace's tiled layout" }),
});

/** A workspace as the LIST returns it: the row plus every pane, in membership order. */
export const WorkspaceListItemSchema = t.Object({
  ...WorkspaceSchema.properties,
  panes: t.Array(WorkspacePaneSchema, { description: "Panes in membership order (createdAt)" }),
});

export const HarnessInfoSchema = t.Object({
  id: t.String({ description: "Harness plugin id" }),
  name: t.String({ description: "Display name" }),
  type: t.Union([t.Literal("agent-harness"), t.Literal("terminal"), t.Literal("network")], {
    description:
      "Plugin type from the manifest: an agent CLI, a plain shell, or a network this host can be reached over. A `network` plugin never reaches this schema in practice (`allHarnesses()` excludes it), but the union mirrors the manifest's so the two cannot drift",
  }),
  binary: t.String({ description: 'Executable command name, e.g. "claude"' }),
  envOverride: t.String({
    description:
      'Environment variable that overrides binary lookup for this plugin, e.g. "CLAUDE_PATH" or "SHELL"; empty when the plugin declares no detection',
  }),
  description: t.String({ description: "One-line description" }),
  icon: t.Optional(t.String({ description: "Icon label" })),
  installed: t.Boolean({ description: "Whether the harness binary is usable" }),
  version: t.Optional(t.String({ description: "Installed version" })),
  reason: t.Optional(
    t.Union([t.Literal("not-on-path"), t.Literal("override-invalid"), t.Literal("no-binary")], {
      description:
        "Why the binary was not found: absent from PATH, the known locations and the version-manager layouts, an env override that does not point at an executable, or a plugin that declares no binary at all",
    }),
  ),
  checkedAt: t.Optional(t.String({ description: "ISO 8601 stamp of when detection last ran for this harness" })),
  installedHere: t.Boolean({
    description:
      "Whether the control-plane host has this plugin INSTALLED. Distinct from `installed`, which is about the program the plugin drives",
  }),
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

/** A known env var suggestion for the preset editor. */
export const SuggestedEnvSchema = t.Object({
  key: t.String({ description: "Environment variable name" }),
  description: t.String({ description: "What it does" }),
});

/** A known CLI flag suggestion for the preset editor. */
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
 * How this harness obtains the `subshell mcp` cross-subshell tools. Discriminated:
 * auto harnesses carry only a summary line, manual harnesses only steps —
 * mirrors the harnesses package's McpSetupInfo union.
 */
export const McpSetupSchema = t.Union([
  t.Object({
    mode: t.Literal("auto", { description: "Wired into every subshell automatically" }),
    summary: t.String({ description: "Human summary for the auto case" }),
  }),
  t.Object({
    mode: t.Literal("manual", { description: "One-time user registration on this machine" }),
    steps: t.Array(McpSetupStepSchema, { description: "Ordered copy-paste steps" }),
  }),
]);

/** What a harness can surface of its child agents in the sidebar. */
export const HarnessSubagentSupportSchema = t.Object({
  discovery: t.Union([t.Literal("hooks"), t.Literal("extension")], {
    description: "How subagent lifecycle events reach Subshell",
  }),
  navigation: t.Union([t.Literal("native"), t.Literal("unavailable")], {
    description: "Whether the sidebar can move the parent's own view to a child",
  }),
  setup: t.Optional(t.String({ description: "One-time user action needed for reporting to work, if any" })),
});

/** Everything the preset editor needs to know about one harness. */
export const HarnessSchemaResponseSchema = t.Object({
  settingsFields: t.Array(SettingsFieldSchema, { description: "Settings editor schema (empty if none)" }),
  suggestedEnv: t.Array(SuggestedEnvSchema, { description: "Known env var suggestions" }),
  suggestedFlags: t.Array(SuggestedFlagSchema, { description: "Known CLI flag suggestions" }),
  mcp: McpSetupSchema,
  subagents: t.Nullable(HarnessSubagentSupportSchema, {
    description: "Subagent surfacing this harness supports; null when it reports none",
  }),
});

/**
 * The result of running a built-in agent CLI's own installer on the
 * control-plane host (`POST /api/setup/agents/:pluginId/install`). `harness`
 * is re-probed AFTER the installer exits so one round trip reports both the
 * run's own log and the resulting detection state.
 */
export const AgentInstallResultSchema = t.Object({
  ok: t.Boolean({ description: "Whether the installer exited 0 within the time limit" }),
  exitCode: t.Nullable(t.Number({ description: "The installer's exit code; null when it was killed" })),
  output: t.String({ description: "The installer's stdout then stderr, each capped at 64 KiB" }),
  harness: t.Object(HarnessInfoSchema.properties, {
    description: "The harness's detection state, re-probed after the installer exits",
  }),
});
