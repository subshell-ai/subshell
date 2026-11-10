import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";
import { SUBAGENT_BRIDGE } from "./subagents.js";

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
 * omp composes its terminal title from a brand, one column of run state, and
 * the session label (title-generator's `buildTerminalTitleWithState`):
 * `π > label` while idle, `π <spinner> label` while working, `π ! label` when
 * blocked, and `π : label` when the working separator is pinned to the static
 * colon (WSL, or a spinner pinned off); with titles disabled the form is
 * `π: label`. The brand and the state separator describe the terminal, not the
 * session, and mirroring the whole string read `π ⠋ 🚌 Fix the thing` in the
 * rail — a stuck-looking spinner in front of every name (operator screenshot,
 * 2026-11-09). The label keeps its emoji: the generator starts the session
 * name with one.
 *
 * The whitespace is required where the generator writes one (brand, space,
 * separator), and the disabled form's colon is followed by a space, so a label
 * that merely starts with the brand — `π-calculus`, `π/2`, `π:notes` — keeps
 * it. A bare brand appears for a moment before the session name lands; it
 * parses to nothing, and the caller keeps the name it already had. The spinner
 * set covers every style omp ships: braille frames (U+2801–U+28FF, which holds
 * the activity and dots sets), the pulse moon, and the plain-ASCII line
 * frames.
 */
const TITLE_PREFIX = /^π(?:$|\s+(?:[>!:]|[⠁-⣿]|[◔◑◕○●]|[-\\/|])|:(?=\s|$))\s*/u;

/**
 * Oh My Pi uses its own executable and native MCP discovery, independently of
 * pi. An explicit extension directory contributes mcp.json without redirecting
 * the user's config or credentials. Verified against omp 18.12.6.
 *
 * The same directory carries the subagent bridge. omp keeps its child roster
 * on the session event bus; the extension reports it so the sidebar can hang
 * those children under the parent subshell. omp offers no extension API for
 * moving the parent's terminal onto a child, so navigation stays unavailable.
 */
const createPlugin: HarnessPluginFactory = () => ({
  subagents: { discovery: "extension", navigation: "unavailable" },
  capabilities: () => ["subagents", "mcp", "settings"],

  /** `π <state> <label>`: the label behind the brand and run state is the name. */
  parsePaneTitle: (raw) => raw.replace(TITLE_PREFIX, "").trim(),

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
          omp: { extensions: ["bridge.mjs", "subagents.mjs"] },
        }),
        "bridge.mjs": "export default function () {}\n",
        "subagents.mjs": SUBAGENT_BRIDGE,
        "mcp.json": fileContent,
      },
      args: ["--extension", `${configPath}.d`],
    };
  },

  mcpSetup() {
    return {
      mode: "auto",
      summary:
        "Subshell registers its MCP server and reports the pane's subagents through a per-launch Oh My Pi extension. Your existing configuration stays in place.",
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
