import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID to use", type: "string" },
  {
    key: "reasoningEffort",
    label: "Reasoning effort",
    description: "Reasoning effort supported by the selected model",
    type: "string",
  },
  { key: "agent", label: "Agent", description: "Agent name or definition file path", type: "string" },
  {
    key: "alwaysApprove",
    label: "Auto-approve tools",
    description: "Allow tool executions without asking for permission (dangerous)",
    type: "boolean",
  },
];

/**
 * Launch Grok's interactive TUI with a dedicated agent process per subshell.
 * CLI and MCP behavior verified against xai-org/grok-build at 2bdd1d6a:
 * pager/src/app/cli.rs, pager/src/mcp_cmd.rs and mcp/src/servers.rs.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    // A shared leader can outlive the pane and supply another pane's MCP env.
    // Grok rejects --leader combined with this flag, rather than sharing it.
    const args = [binary, "--no-leader"];
    const settings = preset.settings ?? {};
    for (const [key, flag] of [
      ["model", "--model"],
      ["reasoningEffort", "--reasoning-effort"],
      ["agent", "--agent"],
    ] as const) {
      const value = settings[key];
      if (typeof value === "string" && value) args.push(flag, value);
    }
    if (settings.alwaysApprove === true) args.push("--always-approve");
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  // The interactive CLI has no per-invocation MCP config flag. Register only
  // argv in user config; the stdio child inherits the pane's SUBSHELL_* env.
  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell with the same account and GROK_HOME you use to launch Grok Build:",
          command: `grok mcp add --scope user ${MCP_SERVER_NAME} -- ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`,
        },
        { label: "Remove later with:", command: `grok mcp remove --scope user ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "XAI_API_KEY", description: "xAI API key instead of browser sign-in" },
    {
      key: "GROK_HOME",
      description: "Config/data directory (default: ~/.grok); use the same value for MCP setup and sign-in",
    },
  ],
  suggestedFlags: () => [
    { flag: "--rules <text>", description: "Append instructions to the system prompt" },
    { flag: "--minimal", description: "Use the scrollback interface" },
    { flag: "--fullscreen", description: "Use the fullscreen interface" },
    { flag: "--resume <session-id>", description: "Resume a specific Grok conversation" },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
