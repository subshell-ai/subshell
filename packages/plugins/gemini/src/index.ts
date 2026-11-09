import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const SETTINGS: SettingsField[] = [
  { key: "model", label: "Model", description: "Model ID, e.g. a gemini-* name", type: "string" },
  {
    key: "approvalMode",
    label: "Approval mode",
    description: "How much it may do without asking",
    type: "select",
    choices: ["default", "auto_edit", "yolo", "plan"],
  },
];

/**
 * Launch Gemini's interactive TUI. Flags mapped here were verified against
 * @google/gemini-cli 0.67.0 --help: -m/--model, --approval-mode, --skip-trust,
 * --resume/--session-id. `gemini mcp add` defaults to project scope, which
 * would file the registration inside the checked-out workspace, so the step
 * passes --scope user explicitly (its parser rejects a `--` separator, so the
 * server name and argv follow the options directly).
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp", "settings"],

  buildCommand({ binary, preset, extraFlags }) {
    const args = [binary];
    const settings = preset.settings ?? {};
    if (typeof settings.model === "string" && settings.model) args.push("--model", settings.model);
    if (typeof settings.approvalMode === "string" && settings.approvalMode)
      args.push("--approval-mode", settings.approvalMode);
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
          label: "Register Subshell once for the account and GEMINI_CLI_HOME you launch Gemini with:",
          command: `gemini mcp add --scope user ${MCP_SERVER_NAME} ${[launch.command, ...launch.args].map(host.shellQuote).join(" ")}`,
        },
        { label: "Remove later with:", command: `gemini mcp remove --scope user ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  presetSettings: () => SETTINGS,
  suggestedEnv: () => [
    { key: "GEMINI_API_KEY", description: "AI Studio key instead of browser sign-in" },
    { key: "GOOGLE_API_KEY", description: "Google API key when using the Google provider path" },
    {
      key: "GEMINI_CLI_HOME",
      description:
        "Home directory that holds the .gemini config (default: the OS home, so ~/.gemini); keep sign-in and MCP registration on the same one",
    },
  ],
  suggestedFlags: () => [
    { flag: "--skip-trust", description: "Trust this workspace for the session" },
    { flag: "--resume latest", description: "Continue the most recent conversation" },
    { flag: "--session-id <uuid>", description: "Start under a chosen session id" },
    { flag: "-o json", description: "Machine-readable output (headless runs)" },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
