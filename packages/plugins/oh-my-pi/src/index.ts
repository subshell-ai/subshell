import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID or pattern passed to omp", type: "string" },
  { key: "provider", label: "Provider", description: "Provider name, such as anthropic or openai", type: "string" },
  {
    key: "thinking",
    label: "Thinking level",
    description: "Reasoning effort for the subshell",
    type: "select",
    choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
  },
];

/**
 * Oh My Pi uses its own executable and native MCP discovery, independently of
 * pi. An explicit extension directory contributes mcp.json without redirecting
 * the user's config or credentials. Verified against omp 18.12.6.
 */
const createPlugin: HarnessPluginFactory = () => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags, mcp }) {
    const args = [binary, ...(mcp?.args ?? [])];
    const settings = preset.settings ?? {};
    for (const key of ["model", "provider", "thinking"]) {
      const value = settings[key];
      if (typeof value === "string" && value) args.push(`--${key}`, value);
    }
    // omp has no --name flag or create-time conversation ID. Forward neither
    // a display name nor a resume selector that might pick another subshell.
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  mcpRegistration(launch, configPath) {
    const fileContent = `${JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: { type: "stdio", command: launch.command, args: launch.args },
        },
      },
      null,
      2,
    )}\n`;
    return {
      fileContent,
      files: {
        // Explicit manifest entries allow .mjs; omp's directory scan otherwise
        // only looks for .ts/.js. MCP discovery reads this directory's mcp.json.
        "package.json": JSON.stringify({
          name: "subshell-mcp",
          private: true,
          type: "module",
          omp: { extensions: ["bridge.mjs"] },
        }),
        "bridge.mjs": "export default function () {}\n",
        "mcp.json": fileContent,
      },
      args: ["--extension", `${configPath}.d`],
    };
  },

  mcpSetup() {
    return {
      mode: "auto",
      summary:
        "Subshell registers its MCP server through a per-launch Oh My Pi extension. Your existing configuration stays in place.",
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "ANTHROPIC_API_KEY", description: "Anthropic API key" },
    { key: "OPENAI_API_KEY", description: "OpenAI API key" },
  ],
  suggestedFlags: () => [
    { flag: "--model anthropic/claude-sonnet-4-5", description: "Model in provider/model form" },
    { flag: "--thinking high", description: "Reasoning effort for the subshell" },
    { flag: "--tools read,grep,find", description: "Tools to enable" },
    { flag: "--append-system-prompt <text>", description: "Append instructions to the system prompt" },
    { flag: "--no-session", description: "Don't save the conversation" },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
