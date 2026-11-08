import { type HarnessPluginFactory, MCP_SERVER_NAME, validateGenericPreset } from "@subshell-ai/plugin-api";

/**
 * Launch OpenHands' interactive TUI. A bare run opens textual UI mode (its own
 * help says so), which on a fresh config home leads with a settings wizard
 * where the model and provider are configured. Flags cited here were
 * verified against SDK 1.21.0's `openhands --help`, which exposes no settings
 * flag of any kind, so this plugin ships no preset settings: the LLM_*
 * environment variables reach a launch only when it is started with
 * --override-with-envs, as that flag's own help text says.
 * `openhands mcp add` takes --transport stdio, the command as the target, and
 * its args after a `--` separator; a live sandboxed round trip on 1.21.0
 * stored command+args in ~/.openhands/mcp.json, and `mcp remove` takes the
 * name.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host) => ({
  capabilities: () => ["mcp"],

  buildCommand({ binary, preset, extraFlags }) {
    return [binary, ...preset.flags, ...(extraFlags ?? [])];
  },

  // Registration is global (one mcp.json per config home), and the stored
  // command is not a credential: the stdio child is spawned by the running
  // OpenHands process, so it inherits the pane's SUBSHELL_* env at launch,
  // which is what keeps one pane's credential inside that pane.
  mcpSetup(launch) {
    return {
      mode: "manual",
      steps: [
        {
          label: "Register Subshell once for the OS account OpenHands runs under:",
          command: `openhands mcp add ${MCP_SERVER_NAME} --transport stdio ${host.shellQuote(launch.command)} -- ${launch.args.map((arg) => host.shellQuote(arg)).join(" ")}`,
        },
        { label: "Remove later with:", command: `openhands mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset: validateGenericPreset,
  suggestedEnv: () => [
    { key: "OPENHANDS_SUPPRESS_BANNER", description: "Set to 1 to hide the SDK banner it prints on every start" },
    {
      key: "LLM_MODEL",
      description: "Model ID; applies only when the launch carries --override-with-envs, ignored by default",
    },
    {
      key: "LLM_API_KEY",
      description: "Provider API key; applies only when the launch carries --override-with-envs, ignored by default",
    },
    {
      key: "LLM_BASE_URL",
      description: "Provider base URL; applies only when the launch carries --override-with-envs, ignored by default",
    },
  ],
  suggestedFlags: () => [
    {
      flag: "--last",
      description: "Resume the most recent conversation; its help pairs it with --resume",
    },
    {
      flag: "--always-approve",
      description: "Auto-approve all actions without asking for confirmation (--yolo is an alias)",
    },
    {
      flag: "--headless",
      description: "No UI, auto-approved actions; requires --task or --file",
    },
    {
      flag: "--json",
      description: "Stream JSONL event output; must be used with --headless",
    },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";
