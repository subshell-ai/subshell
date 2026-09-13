/**
 * The pre-extraction pi plugin, frozen as a REFERENCE.
 *
 * `plugin-parity.test.ts` compares the extracted package against this to prove
 * the move changed nothing that gets executed. Deleted with that test once the
 * extraction has been reviewed and shipped; nothing else may import it.
 * @internal
 */
import { validateGenericPreset } from "@subshell-ai/plugin-api";
import { type DetectionResult, detectBinary } from "../../binary-lookup.js";
import type {
  BuildCommandInput,
  McpLaunchSpec,
  McpSetupInfo,
  PresetDefinition,
  PresetValidationResult,
  SettingsField,
} from "../../types.js";
import { MCP_SERVER_NAME } from "../../types.js";
import { probeVersion } from "../../version-probe.js";

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
    description: "Thinking budget for the subshell",
    type: "select",
    choices: ["off", "minimal", "low", "medium", "high", "xhigh"],
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  { key: "PI_CODING_AGENT_DIR", description: "Config directory (default: ~/.pi/agent), isolation knob" },
  { key: "PI_CODING_AGENT_SESSION_DIR", description: "Subshell storage directory" },
  { key: "PI_OFFLINE", description: "Disable startup network operations (1/true)" },
  { key: "PI_TELEMETRY", description: "Override install telemetry (1/0)" },
  { key: "ANTHROPIC_API_KEY", description: "Anthropic API key" },
  { key: "OPENAI_API_KEY", description: "OpenAI API key" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--model sonnet:high", description: "Model pattern with thinking shorthand" },
  { flag: "--provider anthropic", description: "Provider name" },
  { flag: "--thinking high", description: "Thinking level for the subshell" },
  { flag: "--tools read,grep,find,ls", description: "Allowlist of tool names to enable" },
  { flag: "--exclude-tools ask_question", description: "Denylist of tool names to disable" },
  { flag: "--append-system-prompt <text>", description: "Append to the system prompt" },
  { flag: "--no-session", description: "Ephemeral subshell (nothing saved)" },
  { flag: "--offline", description: "Skip startup network operations" },
];

const PLUGIN_KNOWN_PATHS = [".bun/bin/pi"];

/**
 * Built-in harness: pi (pi.dev, Earendil Works).
 *
 * Launch shape:
 *   pi [--model <m>] [--provider <p>] [--thinking <l>] --name <subshell> \
 *      [preset flags] [extra flags]
 * A bare launch opens the TUI. Unlike the other harnesses, pi supports a
 * create-time name for its OWN session (`--name`), so the subshell's display
 * name is forwarded to it.
 *
 * NOTE: subshell MCP is NOT auto-injected. pi deliberately has no built-in MCP —
 * it comes from the community `pi-mcp-adapter` extension, which must be
 * installed once per host. mcpSetup() surfaces the exact steps (install +
 * the standard mcpServers snippet the adapter reads from ~/.config/mcp/mcp.json
 * or a project .mcp.json); the spawned child inherits each subshell's SUBSHELL_* env.
 */
export class PiPlugin {
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

  async detect(): Promise<DetectionResult> {
    if (this.#binaryOverride) {
      // An injected override that does not exist is the same class of mistake
      // as a bad PI_PATH: the caller said where it is and was wrong.
      return (await Bun.file(this.#binaryOverride).exists())
        ? { path: this.#binaryOverride }
        : { path: null, reason: "override-invalid" };
    }
    return detectBinary(this.binaryName, "PI_PATH", PLUGIN_KNOWN_PATHS);
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

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, subshellName, extraFlags } = input;
    const args: string[] = [binary];

    const s = preset.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("--model", s.model);
    if (typeof s.provider === "string" && s.provider) args.push("--provider", s.provider);
    if (typeof s.thinking === "string" && s.thinking) args.push("--thinking", s.thinking);

    if (subshellName) args.push("--name", subshellName);

    // Each stored flag is one complete argv token (see opencode.ts note).
    for (const flag of preset.flags) args.push(flag);

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

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
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
