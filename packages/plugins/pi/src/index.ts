import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  type HarnessSubagentPane,
  type HarnessSubagentSelectInput,
  type HarnessSubagentSelectResult,
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
import { SUBAGENT_BRIDGE } from "./subagents.js";

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

const DOWN = "\u001b[B";
const ESC = "\u001b";
const ENTER = "\r";
const PI_INSPECTOR_FOOTER = /esc\s+(?:close|closes)/i;
const PI_INSPECTOR_HEADER = /(?:subagent fleet inspector|subagents fleet)/i;
const PI_INSPECTOR_GLYPH_ROW = /^\s*[│|]?\s*([›>])?\s*[●○◐◑◒◓◔◕◖◗✓✗✔✘…]\s*([^\s·│[]+)/;
const PI_INSPECTOR_TEXT_ROW = /^\s*[│|]?\s*([›>])?\s*([^\s·│]+)\s+·\s+\S/;
const PI_INSPECTOR_CHROME = /(?:Prompt Audit|[↑↓]\/[jk]|esc\s+(?:close|closes))/i;

function piComposerText(screen: string): string {
  const line = screen
    .split("\n")
    .reverse()
    .find((row) => /^\s*❯\s*/.test(row));
  return line?.replace(/^\s*❯\s*/, "").trim() ?? "";
}

function piInspectorRows(screen: string): { name: string; selected: boolean }[] {
  const lines = screen.split("\n");
  const header = lines.findIndex((line) => PI_INSPECTOR_HEADER.test(line));
  const divider = lines.findIndex((line, index) => index > header && /[├└╰]/u.test(line));
  const start = divider < 0 ? header + 1 : divider + 1;
  const end = lines.findIndex((line, index) => index >= start && /[├└╰]/u.test(line));
  const body = lines.slice(start, end < 0 ? undefined : end);
  return body
    .filter((line) => !PI_INSPECTOR_CHROME.test(line))
    .map((line) => line.match(PI_INSPECTOR_GLYPH_ROW) ?? line.match(PI_INSPECTOR_TEXT_ROW))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ name: (match[2] ?? "").trim(), selected: match[1] === "›" || match[1] === ">" }));
}

function piHasInspector(screen: string): boolean {
  return PI_INSPECTOR_HEADER.test(screen) || PI_INSPECTOR_FOOTER.test(screen);
}

async function piWaitFor(
  pane: HarnessSubagentPane,
  predicate: (screen: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let screen = await pane.read();
  while (!predicate(screen)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for pi's subagent fleet.");
    await new Promise((resolve) => setTimeout(resolve, 75));
    screen = await pane.read();
  }
  return screen;
}

async function selectPiSubagent(input: HarnessSubagentSelectInput): Promise<HarnessSubagentSelectResult> {
  const { agentId, agents, pane } = input;
  let screen = await pane.read();
  if (agentId === null) {
    if (piHasInspector(screen)) await pane.type(ESC);
    return { selectedId: null };
  }
  const target = agents.find((agent) => agent.id === agentId);
  if (!target) throw new Error("pi didn't report that subagent.");
  if (!piHasInspector(screen)) {
    if (piComposerText(screen)) throw new Error("Finish or clear the prompt before inspecting a subagent.");
    await pane.type("/subagents-fleet");
    await pane.type(ENTER);
    screen = await piWaitFor(pane, piHasInspector, 3000);
  }
  const rows = piInspectorRows(screen);
  const targetName = target.name.trim();
  const ordinal = agents.filter((agent) => agent.name.trim() === targetName).findIndex((agent) => agent.id === agentId);
  const matchingRows = rows.flatMap((row, index) => (row.name === targetName ? [index] : []));
  const targetRow = matchingRows[ordinal] ?? -1;
  if (targetRow < 0) throw new Error("pi didn't list that subagent in its fleet.");
  let selected = rows.findIndex((row) => row.selected);
  if (selected < 0) selected = 0;
  for (let i = selected; i < targetRow; i++) await pane.type(DOWN);
  const after = piInspectorRows(await pane.read());
  if (!after[targetRow]?.selected) throw new Error("pi didn't select that subagent in its fleet.");
  return { selectedId: agentId };
}

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
  subagents: { discovery: "extension", navigation: "native", select: selectPiSubagent },
  /**
   * Named for the host's MCP wiring slot, but pi gets no MCP config from it:
   * subshell MCP stays a manual install (see `mcpSetup`). What this really
   * ships is the subagent bridge: the `{}` is the placeholder config file
   * whose sibling `.d` directory carries `subagents.mjs`, and the args splice
   * `--extension` onto the launch so pi loads it. No secrets; the file exists
   * to give the companion a home path.
   */
  mcpRegistration(_launch, configPath) {
    return {
      fileContent: "{}",
      files: { "subagents.mjs": SUBAGENT_BRIDGE },
      args: ["--extension", `${configPath}.d/subagents.mjs`],
    };
  },
  capabilities: (): PluginCapability[] => ["subagents", "mcp", "settings"],

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, subshellName, extraFlags } = input;
    const args: string[] = [binary, ...(input.mcp?.args ?? [])];

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
   * the adapter's standard `mcpServers` file. Steps carry the PORTABLE PATH
   * launch (`subshell mcp`, not this plane's resolved one) so the snippet is
   * copy-paste correct on every machine that hosts a pane (issue #57).
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
