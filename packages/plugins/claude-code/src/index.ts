import { join, resolve } from "node:path";
import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  type HarnessResume,
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
 * - `UserPromptSubmit` / `PreToolUse` — the waiting CLEAR (`resumed`). The
 *   plane's idle-watcher can only clear what it can stat, so an agent-node
 *   pane — log on the node's disk — stayed "waiting for you" for its whole
 *   next turn (2026-09-24). The pane knows better: work has resumed when the
 *   human's prompt is submitted, AND when a tool starts after an approval
 *   answered in the dialog (approving is not a prompt, so
 *   UserPromptSubmit alone misses that path). PreToolUse fires on every tool
 *   call; the endpoint's clear is conditional, so the common stamp-less case
 *   is a silent no-op. Neither hook's stdin is read — their payloads are the
 *   prompt text and the tool input, and the report is only ever the fact.
 * - `SessionStart` — conversation identity. The restart-resume pin
 *   (`--session-id` at launch) only survives while the pane keeps that ONE
 *   conversation, but /clear, /resume <other> and /fork start a DIFFERENT
 *   transcript id in-pane and nothing else tells the server, so the next
 *   restart would resurrect a stale conversation (observed 2026-09-03). This
 *   fires on every such transition (source: startup|resume|clear|compact|fork)
 *   and reads stdin like `Stop` now does — the reporter forwards `session_id`
 *   from that payload and nothing else.
 */
const attentionHooks = (host: PluginHost, reporter: ReporterSpec) => ({
  Stop: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "turn_complete") }] }],
  Notification: [
    {
      matcher: "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
      hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "needs_attention") }],
    },
  ],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "resumed") }] }],
  PreToolUse: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "resumed") }] }],
  SessionStart: [{ hooks: [{ type: "command", command: reporterHook(host, reporter, "session") }] }],
});

/** Claude's transcript folder name for a project dir: every non-alphanumeric → `-`. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
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
  capabilities: (): PluginCapability[] => ["mcp", "resume", "attention", "settings"],

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
      settings.hooks = attentionHooks(host, reporter);
    } else {
      host.log.warn("no reporter resolved for this launch: attention and conversation-identity hooks are omitted");
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
