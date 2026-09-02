import { findBinary } from "./binary-lookup.js";
import type {
  BuildCommandInput,
  HarnessPlugin,
  McpLaunchSpec,
  McpSetupInfo,
  ProfileDefinition,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
import { MCP_SERVER_NAME } from "./types.js";
import { validateGenericProfile } from "./validate.js";

/** pi per-invocation overrides, applied as CLI flags. */
const PI_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "model",
    label: "Model",
    description: "Model pattern or ID ('provider/id' with optional ':<thinking>')",
    type: "string",
  },
  {
    key: "provider",
    label: "Provider",
    description: "Provider name (e.g. 'anthropic', 'openai')",
    type: "string",
  },
  {
    key: "thinking",
    label: "Thinking level",
    description: "Thinking budget for the session",
    type: "select",
    choices: ["off", "minimal", "low", "medium", "high", "xhigh"],
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  { key: "PI_CODING_AGENT_DIR", description: "Config directory (default: ~/.pi/agent) — isolation knob" },
  { key: "PI_CODING_AGENT_SESSION_DIR", description: "Session storage directory" },
  { key: "PI_OFFLINE", description: "Disable startup network operations (1/true)" },
  { key: "PI_TELEMETRY", description: "Override install telemetry (1/0)" },
  { key: "ANTHROPIC_API_KEY", description: "Anthropic API key" },
  { key: "OPENAI_API_KEY", description: "OpenAI API key" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--model sonnet:high", description: "Model pattern with thinking shorthand" },
  { flag: "--provider anthropic", description: "Provider name" },
  { flag: "--thinking high", description: "Thinking level for the session" },
  { flag: "--tools read,grep,find,ls", description: "Allowlist of tool names to enable" },
  { flag: "--exclude-tools ask_question", description: "Denylist of tool names to disable" },
  { flag: "--append-system-prompt <text>", description: "Append to the system prompt" },
  { flag: "--no-session", description: "Ephemeral session (nothing saved)" },
  { flag: "--offline", description: "Skip startup network operations" },
];

const PLUGIN_KNOWN_PATHS = [".bun/bin/pi"];

/**
 * Built-in harness: pi (pi.dev, Earendil Works).
 *
 * Launch shape:
 *   pi [--model <m>] [--provider <p>] [--thinking <l>] --name <session> \
 *      [profile flags] [extra flags]
 * A bare launch opens the TUI. Unlike the other harnesses, pi supports a
 * create-time session name (`--name`), so the subshell session name is forwarded.
 *
 * NOTE: subshell MCP is NOT auto-injected. pi deliberately has no built-in MCP —
 * it comes from the community `pi-mcp-adapter` extension, which must be
 * installed once per host. mcpSetup() surfaces the exact steps (install +
 * the standard mcpServers snippet the adapter reads from ~/.config/mcp/mcp.json
 * or a project .mcp.json); the spawned child inherits each session's SUBSHELL_* env.
 */
export class PiPlugin implements HarnessPlugin {
  readonly id = "pi";
  readonly name = "pi";
  readonly binaryName = "pi";
  readonly description = "Minimal, extensible agent harness from pi.dev (interactive TUI)";
  readonly icon = "π";
  readonly ttyRequired = true;
  readonly enabledByDefault = true;
  readonly installHint = {
    command: "curl -fsSL https://pi.dev/install.sh | sh",
    docsUrl: "https://pi.dev/docs",
  };

  /** Binary override; injectable for tests. */
  readonly #binaryOverride: string | null;

  constructor(binaryOverride: string | null = null) {
    this.#binaryOverride = binaryOverride;
  }

  async findBinary(): Promise<string | null> {
    if (this.#binaryOverride) {
      return (await Bun.file(this.#binaryOverride).exists()) ? this.#binaryOverride : null;
    }
    return findBinary(this.binaryName, "PI_PATH", PLUGIN_KNOWN_PATHS);
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findBinary()) !== null;
  }

  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    if (!binary) return null;
    try {
      const proc = Bun.spawn({ cmd: [binary, "--version"], stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, sessionName, extraFlags } = input;
    const args: string[] = [binary];

    const s = profile.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("--model", s.model);
    if (typeof s.provider === "string" && s.provider) args.push("--provider", s.provider);
    if (typeof s.thinking === "string" && s.thinking) args.push("--thinking", s.thinking);

    if (sessionName) args.push("--name", sessionName);

    // Each stored flag is one complete argv token (see opencode.ts note).
    for (const flag of profile.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  }

  /**
   * Manual, two-step setup: pi has no built-in MCP, so the community
   * `pi-mcp-adapter` extension must be installed once, then subshell registered in
   * the adapter's standard `mcpServers` file. Steps carry the resolved launch
   * so the snippet is copy-paste correct.
   */
  mcpSetup(launch: McpLaunchSpec): McpSetupInfo {
    const snippet = JSON.stringify(
      { mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } },
      null,
      2,
    );
    return {
      mode: "manual",
      steps: [
        { label: "Install the MCP adapter extension once:", command: "pi install npm:pi-mcp-adapter" },
        {
          label: `Register ${MCP_SERVER_NAME} in ~/.config/mcp/mcp.json (or a project .mcp.json):`,
          command: snippet,
        },
      ],
    };
  }

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  }

  settingsFields(): SettingsField[] {
    return PI_SETTINGS_FIELDS;
  }

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  }

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  }
}
