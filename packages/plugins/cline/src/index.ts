import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID for the selected provider", type: "string" },
  { key: "provider", label: "Provider", description: "Provider id (default: cline)", type: "string" },
  {
    key: "thinking",
    label: "Reasoning effort",
    description: "How much the model thinks before answering",
    type: "select",
    choices: ["none", "low", "medium", "high", "xhigh"],
  },
];

/**
 * Launch Cline's interactive TUI, which 3.0.74 opens with `-i, --tui` rather
 * than on a bare run (a bare run takes a prompt and works headless). Flags
 * mapped here were verified against `cline --help`: -m/--model,
 * -P/--provider, --thinking <none|low|medium|high|xhigh>. `cline mcp add`
 * opens the registration wizard with the server fields prefilled; `--yes`
 * installs without opening it, and the stdio command and args follow a `--`
 * separator, which Cline's parser accepts (live round trip on 3.0.74).
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    const args = [binary, "-i"];
    const settings = preset.settings ?? {};
    if (typeof settings.model === "string" && settings.model) args.push("--model", settings.model);
    if (typeof settings.provider === "string" && settings.provider) args.push("--provider", settings.provider);
    if (typeof settings.thinking === "string" && settings.thinking) args.push("--thinking", settings.thinking);
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  // The interactive CLI has no per-invocation MCP config flag, so registration
  // is a one-time step on the execution host, stored under the config dir
  // (CLINE_DIR or ~/.cline). The stored command is not a credential: the stdio
  // child is spawned by the running cline process, so it inherits the pane's
  // SUBSHELL_* env at launch, which is what keeps one pane's credential inside
  // that pane.
  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell once, without opening the add wizard, for the CLINE_DIR you launch Cline with:",
          command: `cline mcp add --yes ${MCP_SERVER_NAME} -- ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`,
        },
        { label: "Remove later with:", command: `cline mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "ANTHROPIC_API_KEY", description: "Provider key for Anthropic models" },
    { key: "OPENAI_API_KEY", description: "Provider key for OpenAI models" },
    {
      key: "CLINE_DIR",
      description: "Config directory (default: ~/.cline); keep sign-in and MCP registration on the same one",
    },
  ],
  suggestedFlags: () => [
    { flag: "--auto-approve false", description: "Ask before each tool runs; act mode auto-approves by default" },
    { flag: "--id <session-id>", description: "Resume an existing session by ID" },
    {
      flag: "--retries <n>",
      description: "Max consecutive mistakes before exiting (default: 3)",
    },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
