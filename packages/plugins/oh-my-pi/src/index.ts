import {
  type HarnessPluginFactory,
  MCP_SERVER_NAME,
  type SettingsField,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";
import { PREVIEW_BRIDGE } from "./previews.js";
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
 * model-cli hands its provider to a harness through this pane environment
 * variable. The value is the provider config, and its `apiKey` field names
 * MODEL_CLI_OMP_API_KEY rather than carrying the credential itself.
 */
const MODEL_CLI_PROVIDER_CONFIG_ENV = "MODEL_CLI_OMP_CONFIG";
const MODEL_CLI_PROVIDER_KEY_ENV = "MODEL_CLI_OMP_API_KEY";

/**
 * Loads that provider from the environment. The source is fixed: it names the
 * variable and never interpolates its value, so no preset data (and no
 * credential) is written to a node. A launch without the variable loads
 * nothing, which keeps the module inert for every other omp preset.
 *
 * The value is preset-controlled, so malformed or incomplete JSON leaves the
 * module inert too. It must match what `model-cli omp` generates and nothing
 * else: the provider keeps model-cli's namespace, so a preset cannot override
 * a built-in provider; the apiKey is the env-var name rather than a literal
 * secret; and no field may carry omp's `!command` config syntax, which would
 * run shell commands as the pane user. Registration is queued outside the
 * extension factory's error guard, so a value omp would reject there would
 * take the pane down at startup instead of warning. One debug line names the
 * problem, never the value.
 *
 * A preset built from `model-cli omp` used to name its provider by an
 * `--extension` path in the generating host's cache, so it only worked on
 * machines where model-cli had run. This module rides the per-launch
 * extension directory the host already ships to every node instead.
 */
const MODEL_CLI_PROVIDER_SHIM = `export default function(pi) {
  const raw = process.env.${MODEL_CLI_PROVIDER_CONFIG_ENV};
  if (!raw) return;
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    pi.logger?.debug?.("model-cli provider config ignored: MODEL_CLI_OMP_CONFIG is not JSON");
    return;
  }

  const CONNECTION_KEYS = ["baseUrl", "api", "apiKey", "models"];
  const MODEL_KEYS = [
    "id",
    "name",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "cost",
    "compat",
    "thinking",
  ];
  const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
  const COMPAT_KEYS = [
    "maxTokensField",
    "reasoningContentField",
    "replayReasoningContent",
    "requiresReasoningContentForAllAssistantTurns",
    "supportsDeveloperRole",
    "supportsStore",
    "supportsStrictMode",
    "thinkingFormat",
  ];
  const THINKING_KEYS = ["mode", "efforts", "effortMap"];

  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
  const text = (value) => typeof value === "string" && value !== "";
  const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const positive = (value) => amount(value) && value > 0;
  const command = (value) => {
    if (typeof value === "string") return value.startsWith("!");
    if (Array.isArray(value)) return value.some(command);
    if (isObject(value)) return Object.values(value).some(command);
    return false;
  };
  const cost = (value) => isObject(value) && only(value, COST_KEYS) && Object.values(value).every(amount);
  const compat = (value) =>
    isObject(value) &&
    only(value, COMPAT_KEYS) &&
    Object.values(value).every((item) => typeof item === "string" || typeof item === "boolean");
  const thinking = (value) =>
    isObject(value) &&
    only(value, THINKING_KEYS) &&
    (value.mode === "anthropic-adaptive" || value.mode === "effort") &&
    Array.isArray(value.efforts) &&
    value.efforts.every(text) &&
    isObject(value.effortMap) &&
    Object.values(value.effortMap).every(text);
  const model = (value) =>
    isObject(value) &&
    only(value, MODEL_KEYS) &&
    text(value.id) &&
    (value.name === undefined || text(value.name)) &&
    (value.contextWindow === undefined || positive(value.contextWindow)) &&
    (value.maxTokens === undefined || positive(value.maxTokens)) &&
    (value.reasoning === undefined || typeof value.reasoning === "boolean") &&
    (value.input === undefined ||
      (Array.isArray(value.input) && value.input.every((item) => item === "text" || item === "image"))) &&
    (value.cost === undefined || cost(value.cost)) &&
    (value.compat === undefined || compat(value.compat)) &&
    (value.thinking === undefined || thinking(value.thinking));

  const connection = config?.connection;
  const models = connection?.models;
  const usable =
    typeof config?.provider === "string" &&
    /^model-cli-omp-(?:litellm|direct)-\\S+$/.test(config.provider) &&
    isObject(connection) &&
    only(connection, CONNECTION_KEYS) &&
    typeof connection.baseUrl === "string" &&
    /^https?:\\/\\/.+/.test(connection.baseUrl) &&
    (connection.api === "anthropic-messages" || connection.api === "openai-completions") &&
    connection.apiKey === "${MODEL_CLI_PROVIDER_KEY_ENV}" &&
    Array.isArray(models) &&
    models.length > 0 &&
    models.every(model) &&
    !command(config);
  if (!usable) {
    pi.logger?.debug?.("model-cli provider config ignored: MODEL_CLI_OMP_CONFIG is not the model-cli shape");
    return;
  }
  pi.registerProvider(config.provider, connection);
}
`;

/**
 * A preset built from `model-cli omp` used to prove its provider with an
 * extension path in the generating host's cache. That file is writable by
 * anything running as the pane user and persists between launches, so the
 * provider module below is a replacement, not a companion: the legacy flag is
 * dropped when this launch writes its own module. omp accepts the path as
 * `--extension`, `--trusted-extension`, `-e` or `--hook`, so every spelling is
 * matched, and the path is normalized first because `./` and doubled
 * separators name the same file.
 */
const LEGACY_PROVIDER_FLAGS = ["--extension", "--trusted-extension", "-e", "--hook"];
const LEGACY_PROVIDER_INLINE = ["--extension=", "--trusted-extension=", "-e=", "--hook="];

function isLegacyProviderPath(value: string): boolean {
  const segments = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return /(?:^|\/)model-cli\/omp-provider\.mjs$/.test(segments.join("/"));
}

function withoutLegacyProviderExtension(flags: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (LEGACY_PROVIDER_FLAGS.includes(flag) && isLegacyProviderPath(flags[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    const inline = LEGACY_PROVIDER_INLINE.find((prefix) => flag.startsWith(prefix));
    if (inline && isLegacyProviderPath(flag.slice(inline.length))) continue;
    kept.push(flag);
  }
  return kept;
}

/**
 * Oh My Pi uses its own executable and native MCP discovery, independently of
 * pi. An explicit extension directory contributes mcp.json without redirecting
 * the user's config or credentials. Verified against omp 18.12.6.
 *
 * The same directory carries the subagent bridge. omp keeps its child roster
 * on the session event bus; the extension reports it so the sidebar can hang
 * those children under the parent subshell. omp has no extension hook for
 * moving the parent's terminal onto a child yet, so the bridge reaches the
 * TUI's own public focus method through the class omp exposes as
 * pi.pi.InteractiveMode (verified against 18.18.7). If that surface goes
 * away, the bridge falls back to status-only reporting.
 */
const createPlugin: HarnessPluginFactory = () => ({
  subagents: { discovery: "extension", navigation: "native" },
  previews: { reporting: "extension" },
  capabilities: () => ["subagents", "previews", "mcp", "settings"],

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
    // A legacy model-cli provider flag is dropped when the launch wrote the
    // per-launch provider module (mcp is present only then).
    args.push(...(mcp ? withoutLegacyProviderExtension(preset.flags) : preset.flags), ...(extraFlags ?? []));
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
          omp: { extensions: ["bridge.mjs", "subagents.mjs", "previews.mjs", "provider.mjs"] },
        }),
        "bridge.mjs": "export default function () {}\n",
        "subagents.mjs": SUBAGENT_BRIDGE,
        "previews.mjs": PREVIEW_BRIDGE,
        "provider.mjs": MODEL_CLI_PROVIDER_SHIM,
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
