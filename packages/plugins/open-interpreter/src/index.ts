import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID for the configured provider", type: "string" },
];

/**
 * Launch Open Interpreter's interactive TUI, which 0.0.59 opens on a bare run
 * (its help forwards any options without a subcommand to the interactive CLI).
 * Flags mapped here were verified against `interpreter --help`: -m/--model,
 * --ask-for-approval <on-request|never>, --approve-for-me, and --sandbox.
 * `interpreter mcp add` takes the stdio command and its args after a `--`
 * separator; a live sandboxed round trip on 0.0.59 stored command+args under
 * [mcp_servers] in config.toml, and `interpreter mcp remove` takes the name.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    const args = [binary];
    const settings = preset.settings ?? {};
    if (typeof settings.model === "string" && settings.model) args.push("--model", settings.model);
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  // Registration is global (one config.toml per config home), and the stored
  // command is not a credential: the stdio child is spawned by the running
  // interpreter process, so it inherits the pane's SUBSHELL_* env at launch,
  // which is what keeps one pane's credential inside that pane.
  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell once for the INTERPRETER_HOME you launch Open Interpreter with:",
          command: `interpreter mcp add ${MCP_SERVER_NAME} -- ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`,
        },
        { label: "Remove later with:", command: `interpreter mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "OPENAI_API_KEY", description: "OpenAI API key for usage-based billing without ChatGPT sign-in" },
    {
      key: "INTERPRETER_HOME",
      description:
        "Config directory holding config.toml (default: ~/.openinterpreter); keep sign-in and MCP registration on the same one",
    },
  ],
  suggestedFlags: () => [
    {
      flag: '-c model="<id>"',
      description: "Override any config value for this run; the dotted-path value is parsed as TOML",
    },
    {
      flag: "--ask-for-approval never",
      description: "Run commands without asking; execution failures are returned to the model",
    },
    {
      flag: "--approve-for-me",
      description: "Review approval requests automatically through the workspace-write sandbox",
    },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
