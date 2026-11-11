import { join, resolve } from "node:path";
import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  type HarnessResume,
  type HarnessSubagentSelectInput,
  type HarnessSubagentSelectResult,
  MCP_SERVER_NAME,
  type McpLaunchSpec,
  type McpRegistration,
  type McpSetupInfo,
  type PluginCapability,
  type PluginHost,
  type PresetDefinition,
  type PresetValidationResult,
  type ReporterSpec,
  type SettingsField,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

/** Known claude-code settings editor fields (top-level `--settings` keys). */
const CLAUDE_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "permissionMode",
    label: "Permission mode",
    description: "How permissions are handled for tool use",
    type: "select",
    choices: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"],
  },
  {
    key: "model",
    label: "Model",
    description: "Model alias or full name (e.g. 'sonnet', 'opus', 'fable')",
    type: "string",
  },
  {
    key: "maxTokens",
    label: "Max output tokens",
    type: "number",
  },
  {
    key: "outputStyle",
    label: "Output style",
    type: "select",
    choices: ["default", "compact", "expanded"],
  },
  {
    key: "alwaysAllowReadOnly",
    label: "Always allow read-only tools",
    type: "boolean",
  },
  {
    key: "includeCoAuthoredBy",
    label: "Add Co-Authored-By footer",
    type: "boolean",
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  { key: "ANTHROPIC_API_KEY", description: "API key (overrides logged-in account)" },
  { key: "ANTHROPIC_AUTH_TOKEN", description: "OAuth/bearer token instead of an API key" },
  { key: "ANTHROPIC_MODEL", description: "Model alias (deprecated in favor of settings)" },
  { key: "ANTHROPIC_BASE_URL", description: "API base URL (e.g. a gateway/proxy)" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", description: "Model behind the 'sonnet' alias" },
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", description: "Model behind the 'opus' alias" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", description: "Model behind the 'haiku' alias" },
  { key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", description: "Max output tokens" },
  { key: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", description: "Disable telemetry/update traffic (1)" },
  {
    key: "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN",
    description: "Classic renderer: appends to scrollback so the pane shows a scrollbar (1)",
  },
  {
    key: "CLAUDE_CODE_SSE_URL",
    description: "Anthropic SSE URL override (e.g. http://localhost:8080/anthropic)",
  },
  { key: "CLAUDE_CODE_USE_BEDROCK", description: "Use Amazon Bedrock (1)" },
  { key: "CLAUDE_CODE_USE_VERTEX", description: "Use Google Vertex AI (1)" },
  { key: "BASH_DEFAULT_TIMEOUT_MS", description: "Default timeout for Bash tool commands" },
  { key: "MAX_THINKING_TOKENS", description: "Cap on extended-thinking tokens" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--dangerously-skip-permissions", description: "Skip all permission prompts" },
  { flag: "--permission-mode plan", description: "Start in plan mode" },
  { flag: "--model sonnet", description: "Use a specific model alias" },
  { flag: "--effort high", description: "Effort level for the subshell" },
  { flag: "--fallback-model opus", description: "Fall back when the primary model is overloaded" },
  { flag: "--agent reviewer", description: "Use a custom agent definition" },
  { flag: "--append-system-prompt <text>", description: "Append to the system prompt" },
  { flag: "--allowedTools Bash,Read,Edit", description: "Allow only these tools" },
  { flag: "--disallowedTools WebSearch", description: "Deny these tools" },
  { flag: "--mcp-config <path>", description: "Load MCP servers from a JSON file" },
  { flag: "--max-turns <n>", description: "Cap agentic turns (print mode)" },
  { flag: "--continue", description: "Continue the most recent conversation" },
  { flag: "--resume <id>", description: "Resume a specific past conversation" },
  { flag: "--fork-session", description: "Fork instead of resuming in place" },
  { flag: "--worktree", description: "Run in a fresh git worktree" },
];

// `.npm-global/bin` for parity with codex: the npm install route is the
// documented one, and a plain `npm config set prefix ~/.npm-global` lands
// there. A version-manager prefix (nvm, fnm, volta) cannot be named statically
// and is covered by the login-PATH rung in `binary-lookup.ts` instead.

/**
 * One hook command line: the host-resolved reporter, then this hook's verb
 * words, every element POSIX-quoted.
 *
 * A hook runs on the PANE's machine, so the command has to name something that
 * exists there. It used to be `bun -e '<inlined JS>'` — bun was on the pane
 * PATH because the container image shipped it, and no curl was there to use
 * instead. That assumption did not survive leaving the container: on a desktop
 * install the machine has the subshell binary and nothing else, and Claude Code
 * opened every session with `/bin/sh: bun: command not found` while
 * notifications and conversation identity silently never worked.
 *
 * So the reporting moved INTO the binary (`<self> report …`), and what the
 * plugin composes is an argv rather than a program. Bounds, credentials and
 * which fields travel are that subcommand's contract now, which is also why
 * this function no longer needs to know the pane env exists.
 */
const reporterHook = (host: PluginHost, reporter: ReporterSpec, ...verb: string[]): string =>
  [reporter.command, ...reporter.args, ...verb].map((word) => host.shellQuote(word)).join(" ");

/**
 * The `--settings` hooks object for one launch.
 *
 * - `Stop` / `Notification` — fire-and-forget attention reporting. The server
 *   gates delivery on the subshell's bell and derives the "waiting for you"
 *   state; a missed event costs one notification, never a broken turn.
 *   `Notification` carries a matcher because the unfiltered hook rang
 *   "Needs your approval" for EVERY notification type — `idle_prompt`,
 *   `auth_success`, `elicitation_complete` after the human had already
 *   answered (spec 2026-09-23). `Stop` reports `turn_complete` blind here:
 *   the reporter reads the hook payload and stays silent for a session
 *   parked on background work (`packages/mcp-core/src/report.ts`).
 *   `Stop` carries a second command, `report subagents`: the turn-end payload
 *   enumerates the harness's live background agents, and the server replaces
 *   its roster with that set. Edge events cannot reconcile it alone — a
 *   background child killed with `TaskStop` fires no lifecycle hook at all,
 *   so its row would pin the rail "running" forever (measured on Claude Code
 *   2.1.296; the rail then only self-heals at the next turn boundary).
 * - `UserPromptSubmit` / `PreToolUse` (the matcher-less entry) — the waiting
 *   CLEAR (`resumed`). The plane's idle-watcher can only clear what it can
 *   stat, so an agent-node pane — log on the node's disk — stayed "waiting
 *   for you" for its whole next turn (2026-09-24). The pane knows better:
 *   work has resumed when the human's prompt is submitted, AND when a tool
 *   starts after an approval answered in the dialog (approving is not a
 *   prompt, so UserPromptSubmit alone misses that path). PreToolUse fires on
 *   every tool call; the endpoint's clear is conditional, so the common
 *   stamp-less case is a silent no-op. Neither of these two reads its stdin:
 *   their payloads are the prompt text and the tool input, and the report is
 *   only ever the fact.
 * - `PreToolUse` with `Agent|Task` — subagent spawn labels. Claude's
 *   SubagentStart payload has no description field, but the spawn's tool
 *   input does, so this second entry runs the same `report subagents` verb,
 *   which forwards names and descriptions, never prompts or commands.
 * - `SessionStart` — conversation identity. The restart-resume pin
 *   (`--session-id` at launch) only survives while the pane keeps that ONE
 *   conversation, but /clear, /resume <other> and /fork start a DIFFERENT
 *   transcript id in-pane and nothing else tells the server, so the next
 *   restart would resurrect a stale conversation (observed 2026-09-03). This
 *   fires on every such transition (source: startup|resume|clear|compact|fork)
 *   and reads stdin like `Stop` now does — the reporter forwards `session_id`
 *   from that payload and nothing else.
 */
const paneHooks = (host: PluginHost, reporter: ReporterSpec) => ({
  SubagentStart: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "subagents") }] }],
  SubagentStop: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "subagents") }] }],
  Stop: [
    {
      hooks: [
        { type: "command", command: reporterHook(host, reporter, "attention", "turn_complete") },
        { type: "command", command: reporterHook(host, reporter, "subagents") },
      ],
    },
  ],
  Notification: [
    {
      matcher: "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
      hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "needs_attention") }],
    },
  ],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "resumed") }] }],
  PreToolUse: [
    { hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "resumed") }] },
    { matcher: "Agent|Task", hooks: [{ type: "command", command: reporterHook(host, reporter, "subagents") }] },
  ],
  PostToolUse: [
    { matcher: "Agent|Task", hooks: [{ type: "command", command: reporterHook(host, reporter, "subagents") }] },
  ],
  SessionStart: [
    {
      hooks: [
        { type: "command", command: reporterHook(host, reporter, "session") },
        { type: "command", command: reporterHook(host, reporter, "subagents") },
      ],
    },
  ],
});

/** Claude's transcript folder name for a project dir: every non-alphanumeric → `-`. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Claude Code puts a cycling status glyph at the front of its pane title
 * (`✳ Ship the rename feature`, then `✻ …` on the next sweep). The glyph is
 * Claude's run state, not part of the session name, and leaving it in made the
 * mirrored name churn between sweeps. Strip the leading decoration — glyphs,
 * punctuation, and the space after them — so only the task text remains. A
 * title that is nothing but the glyph parses to nothing, and the caller keeps
 * the name it already had.
 */
const STATUS_GLYPH = /^[^\p{L}\p{N}]+/u;

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const ESC = "\u001b";
const CLAUDE_SELECT_MARK = "[>❯]";
const CLAUDE_STATUS_GLYPH = "[●◉◯○◦•]";
const CLAUDE_AGENT_ROW = new RegExp(
  `^\\s*(${CLAUDE_SELECT_MARK})?\\s*(${CLAUDE_STATUS_GLYPH})?\\s*([^\\s·]+)(?:\\s+·\\s+|\\s{2,})`,
);
const CLAUDE_MAIN_ROW = new RegExp(
  `^\\s*(${CLAUDE_SELECT_MARK})?\\s*(${CLAUDE_STATUS_GLYPH})?\\s*main(?:\\s{2,}.*)?\\s*$`,
);

function claudePanelRows(screen: string): { name: string; selected: boolean }[] {
  const lines = screen.split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*❯\s+(?![●◉◯○◦•])/.test(line));
  return (prompt < 0 ? lines : lines.slice(prompt + 1))
    .map((line) => {
      const main = line.match(CLAUDE_MAIN_ROW);
      if (main) return { name: "main", selected: main[1] === ">" || main[1] === "❯" };
      const agent = line.match(CLAUDE_AGENT_ROW);
      return agent ? { name: (agent[3] ?? "").trim(), selected: agent[1] === ">" || agent[1] === "❯" } : undefined;
    })
    .filter(
      (row): row is { name: string; selected: boolean } =>
        row !== undefined && (row.name === "main" || /^[\p{L}\p{N}_.-]+$/u.test(row.name)),
    );
}

async function selectClaudeSubagent(input: HarnessSubagentSelectInput): Promise<HarnessSubagentSelectResult> {
  const { agentId, agents, pane } = input;
  let screen = await pane.read();
  let rows = claudePanelRows(screen);
  if (agentId === null) {
    if (rows.some((row) => row.selected && row.name === "main")) return { selectedId: null };
    if (!rows.length) {
      const looksLikeChildView = /main\s*>\s*\S/.test(screen) || agents.some((agent) => screen.includes(agent.name));
      if (!looksLikeChildView) throw new Error("Claude isn't showing an agent view to return from.");
      await pane.type(ESC);
      screen = await pane.read();
      rows = claudePanelRows(screen);
    }
    if (!rows.length) throw new Error("Claude isn't showing its agent panel.");
    // An unfocused panel has no selection cursor yet; the first arrow only
    // hands it focus. The server's null is already the parent view, so a
    // panel that has not selected a child needs no input at all.
    if (!rows.some((row) => row.selected)) return { selectedId: null };
    for (let step = 0; step < rows.length + 2; step++) {
      const current = claudePanelRows(await pane.read()).findIndex((row) => row.selected);
      if (current === 0) break;
      await pane.type(UP);
    }
    if (!claudePanelRows(await pane.read()).some((row) => row.selected && row.name === "main"))
      throw new Error("Claude didn't select the main agent in its agent panel.");
    await pane.type(ENTER);
    return { selectedId: null };
  }
  const target = agents.find((agent) => agent.id === agentId);
  if (!target) throw new Error("Claude didn't report that subagent.");
  if (!rows.length) throw new Error("Claude isn't showing its agent panel.");
  const targetName = target.name.trim();
  const ordinal = agents.filter((agent) => agent.name.trim() === targetName).findIndex((agent) => agent.id === agentId);
  const matchingRows = rows.flatMap((row, index) => (row.name === targetName ? [index] : []));
  const targetRow = matchingRows[ordinal] ?? -1;
  if (targetRow < 0) throw new Error("Claude didn't list that subagent in its agent panel.");
  // Move one step at a time against the screen Claude actually painted:
  // the first Down on an unfocused panel only focuses it (the selection
  // cursor stays on main), so a precomputed count overshoots or stalls.
  for (let step = 0; step < rows.length + 2; step++) {
    const current = claudePanelRows(await pane.read()).findIndex((row) => row.selected);
    if (current === targetRow) break;
    await pane.type(current < 0 || current < targetRow ? DOWN : UP);
  }
  if (!claudePanelRows(await pane.read())[targetRow]?.selected)
    throw new Error("Claude didn't select that subagent in its agent panel.");
  await pane.type(ENTER);
  return { selectedId: agentId };
}

/**
 * Built-in harness: Claude Code.
 *
 * Launch shape:
 *   claude --settings <json> --name <subshell> [preset flags] [extra flags]
 * Settings are passed as a JSON string via `--settings` (per-invocation, so
 * preset config never needs to write into the user's real ~/.claude).
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file, which is what lets it list a
 * plugin cheaply and detect `claude` before this plugin is even installed.
 *
 * `host` carries what this module cannot import (binary lookup, the bounded
 * version probe, shell quoting, a namespaced logger). See
 * `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host: PluginHost): SubshellPlugin => ({
  subagents: { discovery: "hooks", navigation: "native", select: selectClaudeSubagent },
  capabilities: (): PluginCapability[] => ["subagents", "mcp", "resume", "attention", "settings"],

  /** Claude Code prefixes its pane title with a cycling status glyph. */
  parsePaneTitle: (raw) => raw.replace(STATUS_GLYPH, "").trim(),

  supportsAttentionHooks: true,

  /**
   * Restart-resume: conversations are PINNED at start (`--session-id <uuid>`)
   * so subshell always knows the exact id to resume by, and resume mode adds
   * `--resume <id>` (Claude appends to the same transcript, so one id
   * survives repeated restarts). Pinning is what avoids both `--continue`'s
   * "most recent in this directory" ambiguity, since several subshells can
   * share a cwd, and parsing the exit banner back out of the pane log.
   */
  resume: {
    allocateHarnessSessionId: () => crypto.randomUUID(),
    /**
     * Claude's state dir: the documented override, else `<homeDir>/.claude`.
     * Both halves come from the TARGET machine's `ready` report, never from
     * this process, and no filesystem is touched (spec 2026-09-10 §5) — that
     * is what lets the control plane build the path for a node it cannot
     * see. The host stats the result and decides; this member cannot answer
     * whether the transcript exists.
     */
    resumePath: (harnessSessionId, cwd, hostEnv) => {
      const override = hostEnv.env.CLAUDE_CONFIG_DIR?.trim();
      const configDir = override ? resolve(override) : join(hostEnv.homeDir, ".claude");
      return join(configDir, "projects", projectSlug(cwd), `${harnessSessionId}.jsonl`);
    },
  } satisfies HarnessResume,

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, subshellName, extraFlags, mcp, harnessSession, reporter } = input;

    const args: string[] = [binary];

    // Subshell channels + subshell orchestration: the registration's own argv
    // (--mcp-config <per-subshell file>) lands right after the binary.
    if (mcp?.args) args.push(...mcp.args);

    // Conversation identity for restart-resume (see `resume` above).
    if (harnessSession) {
      args.push(harnessSession.mode === "resume" ? "--resume" : "--session-id", harnessSession.id);
    }

    // Settings JSON is passed via --settings so presets never touch the
    // user's real ~/.claude files. The attention hooks ride along on every
    // launch the host resolved a reporter for (subshell's signal wins if a
    // preset set its own `hooks` key, a documented limitation whose
    // alternative is no notifications).
    //
    // No reporter means no hooks AT ALL, rather than hooks naming something
    // this machine may not have: an unrunnable command reports exactly as
    // little as an absent one and puts an error in front of the user on every
    // turn. `--settings` is then omitted entirely unless the preset brought
    // settings of its own.
    const settings: Record<string, unknown> = { ...(preset.settings ?? {}) };
    if (reporter) {
      settings.hooks = paneHooks(host, reporter);
    } else {
      host.log.warn(
        "no reporter resolved for this launch: attention, conversation-identity, and subagent-roster hooks are omitted",
      );
    }
    if (Object.keys(settings).length > 0) {
      args.push("--settings", JSON.stringify(settings));
    }

    if (subshellName) {
      args.push("--name", subshellName);
    }

    // Each stored flag is one complete argv token (see opencode's note).
    for (const flag of preset.flags) args.push(flag);

    if (extraFlags) {
      args.push(...extraFlags);
    }

    return args;
  },

  /** Claude Code's `--mcp-config` document: `{ mcpServers: { subshell: {...} } }`. */
  mcpRegistration(launch: McpLaunchSpec, configPath: string): McpRegistration {
    return {
      fileContent: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } }, null, 2)}\n`,
      args: ["--mcp-config", configPath],
    };
  },

  /** Auto: `buildCommand` wires `--mcp-config` into every subshell. */
  mcpSetup(_launch: McpLaunchSpec): McpSetupInfo {
    return {
      mode: "auto",
      summary: "Subshell registers itself with every Claude Code subshell automatically (via --mcp-config).",
    };
  },

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
  },

  presetSettings(): SettingsField[] {
    return CLAUDE_SETTINGS_FIELDS;
  },

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  },

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  },

  exitStatus(code: number): string | null {
    const map: Record<number, string> = {
      1: "error doing work",
      5: "permissions denied",
      10: "closed-loop complete",
      11: "gate closed",
    };
    return map[code] ?? null;
  },
});

export default createPlugin;

export { manifest } from "./manifest.js";
