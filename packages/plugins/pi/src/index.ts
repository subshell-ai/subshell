import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type McpLaunchSpec,
  type McpSetupInfo,
  type PluginCapability,
  type PluginHost,
  type PresetDefinition,
  type PresetValidationResult,
  type SettingsField,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

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
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (_host: PluginHost): SubshellPlugin => ({
  capabilities: (): PluginCapability[] => ["mcp", "settings"],

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
  },

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
  },

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
  },

  presetSettings(): SettingsField[] {
    return PI_SETTINGS_FIELDS;
  },

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  },

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";
