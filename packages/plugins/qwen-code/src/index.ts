import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID, e.g. a qwen3-coder name", type: "string" },
  {
    key: "workflowMode",
    label: "Workflow mode",
    description: "Persistent Workflow guidance mode for the session",
    type: "select",
    choices: ["on", "off"],
  },
];

/**
 * Launch Qwen Code's interactive TUI. Flags mapped here were verified against
 * @qwen-code/qwen-code 0.27.0: -m/--model, --workflow-mode <on|off>,
 * --chat-recording, and --resume (whose history depends on that recording
 * switch, per the flag's own description).
 * `qwen mcp add` already writes to user scope, so the registration step passes
 * no --scope flag; like its Gemini parent, its parser rejects a `--` separator
 * before the server argv, so name and command follow the options directly.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    const args = [binary];
    const settings = preset.settings ?? {};
    if (typeof settings.model === "string" && settings.model) args.push("--model", settings.model);
    if (typeof settings.workflowMode === "string" && settings.workflowMode)
      args.push("--workflow-mode", settings.workflowMode);
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  // The interactive CLI has no per-invocation MCP config flag, so registration
  // is a one-time user-scope step on the execution host. The stdio child the
  // registration spawns inherits the pane's SUBSHELL_* env at launch, which is
  // what keeps one pane's credential inside that pane.
  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell once (user scope) for the QWEN_HOME you launch Qwen Code with:",
          command: `qwen mcp add ${MCP_SERVER_NAME} ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`,
        },
        { label: "Remove later with:", command: `qwen mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "DASHSCOPE_API_KEY", description: "Alibaba ModelStudio key (DashScope) for Qwen models and web search" },
    {
      key: "OPENAI_API_KEY",
      description: "OpenAI-compatible provider key, paired with OPENAI_BASE_URL and OPENAI_MODEL",
    },
    {
      key: "QWEN_HOME",
      description:
        "Config directory holding settings.json (default: ~/.qwen); keep sign-in and MCP registration on the same one",
    },
  ],
  suggestedFlags: () => [
    { flag: "--chat-recording", description: "Save chat history, which --resume reads" },
    {
      flag: "--resume",
      description: "Continue a previous session; fails if recording was disabled (--no-chat-recording or settings)",
    },
    { flag: "-i <prompt>", description: "Open the TUI after running a first prompt" },
    { flag: "--output-format json", description: "Machine-readable output (headless runs)" },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
