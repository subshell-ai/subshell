import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type DetectionResult, detectBinary } from "./binary-lookup.js";
import type {
  BuildCommandInput,
  HarnessPlugin,
  HarnessResume,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  ProfileDefinition,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
import { MCP_SERVER_NAME } from "./types.js";
import { validateGenericProfile } from "./validate.js";
import { probeVersion } from "./version-probe.js";

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
const PLUGIN_KNOWN_PATHS = [
  ".local/bin/claude",
  ".local/share/claude/versions/claude",
  ".claude/local/claude",
  ".npm-global/bin/claude",
];

/**
 * Fire-and-forget attention reporting. Each hook runs `bun -e` (bun is on the
 * pane PATH — the image ships it, and no curl exists there) and POSTs the
 * subshell's own bearer to the attention endpoint; the server gates delivery
 * on the subshell's bell and derives the "waiting for you" state. The env
 * vars are baked into the pane by the backend (`subshellMcpEnv`), and every
 * failure path is swallowed: a missing hook event costs one notification,
 * never a broken subshell turn. SUBSHELL_BASE_URL must be reachable from inside
 * the pane's network — in the container that means the published port, which
 * compose already passes via APP_BASE_URL.
 */
const attentionPing = (kind: string): string =>
  `bun -e '` +
  `fetch(process.env.SUBSHELL_BASE_URL+"/api/subshells/"+process.env.SUBSHELL_ID+"/attention",` +
  `{method:"POST",headers:{authorization:"Bearer "+process.env.SUBSHELL_API_KEY,"content-type":"application/json"},` +
  `body:JSON.stringify({kind:${JSON.stringify(kind)}}),signal:AbortSignal.timeout(5000)})` +
  `.catch(()=>{}).finally(()=>process.exit(0))'`;

/**
 * Conversation-identity reporting. The restart-resume pin (`--session-id`
 * at launch) only survives while the pane keeps that ONE conversation — but
 * /clear, /resume <other>, and /fork start a DIFFERENT transcript id in-pane
 * and nothing else tells the server, so the next restart would resurrect a
 * stale conversation (observed 2026-09-03). The SessionStart hook fires on
 * every such transition (source: startup|resume|clear|compact|fork).
 *
 * Unlike the attention pings, THIS command reads stdin — the deliberate,
 * documented exception to the no-stdin rule (whose rationale is that
 * Stop/Notification payloads carry conversation text): the SessionStart
 * payload is pure metadata ({session_id, transcript_path, cwd, source,…})
 * and ONLY `session_id` is forwarded; the response is fire-and-forget like
 * the pings — every failure path is swallowed.
 *
 * Both awaits are bounded: a self-kill timer caps the WHOLE hook (4 s — an
 * unclosed stdin must never stall the pane start, and a SessionStart hook
 * blocks the harness until it exits) and a 2 s fetch timeout caps the POST
 * (a lost report is harmless — the next transition re-reports).
 */
const sessionReportPing = (): string =>
  `bun -e '` +
  `setTimeout(()=>process.exit(0),4000);` +
  `try{const j=JSON.parse(await Bun.stdin.text());` +
  `if(j.session_id)await fetch(process.env.SUBSHELL_BASE_URL+"/api/subshells/"+process.env.SUBSHELL_ID+"/harness-session",` +
  `{method:"POST",headers:{authorization:"Bearer "+process.env.SUBSHELL_API_KEY,"content-type":"application/json"},` +
  `body:JSON.stringify({sessionId:j.session_id}),signal:AbortSignal.timeout(2000)})}catch{}` +
  `process.exit(0)'`;

/** The `--settings` hooks object injected into every Claude Code launch. */
export const ATTENTION_HOOKS = {
  Stop: [{ hooks: [{ type: "command", command: attentionPing("turn_complete") }] }],
  Notification: [{ hooks: [{ type: "command", command: attentionPing("needs_attention") }] }],
  SessionStart: [{ hooks: [{ type: "command", command: sessionReportPing() }] }],
} as const;

/** Claude's state dir: the documented override, else `~/.claude`. */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".claude");
}

/** Claude's transcript folder name for a project dir: every non-alphanumeric → `-`. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Built-in harness: Claude Code.
 *
 * Launch shape:
 *   claude --settings <json> --name <subshell> [profile flags] [extra flags]
 * Settings are passed as a JSON string via `--settings` (per-invocation, so
 * profile config never needs to write into the user's real ~/.claude).
 */
export class ClaudeCodePlugin implements HarnessPlugin {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly binaryName = "claude";
  readonly description = "Anthropic's agentic coding assistant (interactive CLI)";
  readonly icon = "🤖";
  readonly ttyRequired = true;
  readonly enabledByDefault = true;
  readonly supportsAttentionHooks = true;
  readonly installHint = {
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://code.claude.com/docs/en/setup",
  };

  /** Binary override; injectable for tests. */
  readonly #binaryOverride: string | null;

  constructor(binaryOverride: string | null = null) {
    this.#binaryOverride = binaryOverride;
  }

  async detect(): Promise<DetectionResult> {
    if (this.#binaryOverride) {
      // An injected override that does not exist is the same class of mistake
      // as a bad CLAUDE_PATH: the caller said where it is and was wrong.
      return (await Bun.file(this.#binaryOverride).exists())
        ? { path: this.#binaryOverride }
        : { path: null, reason: "override-invalid" };
    }
    return detectBinary(this.binaryName, "CLAUDE_PATH", PLUGIN_KNOWN_PATHS);
  }

  async findBinary(): Promise<string | null> {
    return (await this.detect()).path;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.detect()).path !== null;
  }

  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    return binary ? await probeVersion(binary) : null;
  }

  /**
   * Restart-resume: conversations are PINNED at start (`--session-id <uuid>`)
   * so subshell always knows the exact id to resume by, and resume mode adds
   * `--resume <id>` (Claude appends to the same transcript, so one id
   * survives repeated restarts). Pinning is what avoids both `--continue`'s
   * "most recent in this directory" ambiguity — several subshells can share
   * a cwd — and parsing the exit banner back out of the pane log.
   */
  readonly resume: HarnessResume = {
    allocateHarnessSessionId: () => crypto.randomUUID(),
    canResume: (harnessSessionId, cwd) =>
      existsSync(join(claudeConfigDir(), "projects", projectSlug(cwd), `${harnessSessionId}.jsonl`)),
  };

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, subshellName, extraFlags, mcp, harnessSession } = input;

    const args: string[] = [binary];

    // Subshell channels + subshell orchestration: the registration's own argv
    // (--mcp-config <per-subshell file>) lands right after the binary.
    if (mcp?.args) args.push(...mcp.args);

    // Conversation identity for restart-resume (see `resume` above).
    if (harnessSession) {
      args.push(harnessSession.mode === "resume" ? "--resume" : "--session-id", harnessSession.id);
    }

    // Settings JSON is passed via --settings so profiles never touch the
    // user's real ~/.claude files. The attention hooks ride along on EVERY
    // launch (subshell's signal wins if a profile set its own `hooks` key —
    // documented limitation, the alternative is no notifications).
    const settings = { ...(profile.settings ?? {}), hooks: ATTENTION_HOOKS };
    args.push("--settings", JSON.stringify(settings));

    if (subshellName) {
      args.push("--name", subshellName);
    }

    // Each stored flag is one complete argv token (see opencode.ts note).
    for (const flag of profile.flags) args.push(flag);

    if (extraFlags) {
      args.push(...extraFlags);
    }

    return args;
  }

  /** Claude Code's `--mcp-config` document: `{ mcpServers: { subshell: {...} } }`. */
  mcpRegistration(launch: McpLaunchSpec, configPath: string): McpRegistration {
    return {
      fileContent: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } }, null, 2)}\n`,
      args: ["--mcp-config", configPath],
    };
  }

  /** Auto: `buildCommand` wires `--mcp-config` into every subshell. */
  mcpSetup(_launch: McpLaunchSpec): McpSetupInfo {
    return {
      mode: "auto",
      summary: "Subshell registers itself with every Claude Code subshell automatically (via --mcp-config).",
    };
  }

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  }

  settingsFields(): SettingsField[] {
    return CLAUDE_SETTINGS_FIELDS;
  }

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  }

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  }

  exitStatus(code: number): string | null {
    const map: Record<number, string> = {
      1: "error doing work",
      5: "permissions denied",
      10: "closed-loop complete",
      11: "gate closed",
    };
    return map[code] ?? null;
  }
}
