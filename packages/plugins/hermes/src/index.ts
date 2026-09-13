import {
  type BuildCommandInput,
  MCP_SERVER_NAME,
  type McpLaunchSpec,
  type McpSetupInfo,
  type PluginCapability,
  type PluginFactory,
  type PluginHost,
  type PresetDefinition,
  type PresetValidationResult,
  type SettingsField,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

/** Hermes per-invocation overrides, applied as CLI flags (no config file writes). */
const HERMES_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "model",
    label: "Model",
    description: "Model override for this invocation (e.g. 'anthropic/claude-sonnet-4.6')",
    type: "string",
  },
  {
    key: "provider",
    label: "Provider",
    description: "Provider override (e.g. 'openrouter', 'anthropic')",
    type: "string",
  },
  {
    key: "toolsets",
    label: "Toolsets",
    description: "Comma-separated toolsets to enable for the subshell",
    type: "string",
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  { key: "HERMES_HOME", description: "Config/data directory (default: ~/.hermes), isolation knob" },
  { key: "HERMES_INFERENCE_MODEL", description: "Model override (same value as -m)" },
  { key: "OPENROUTER_API_KEY", description: "OpenRouter API key" },
  { key: "ANTHROPIC_API_KEY", description: "Anthropic API key" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--tui", description: "Force the modern TUI (overrides display.interface)" },
  { flag: "--cli", description: "Force the classic prompt_toolkit REPL" },
  { flag: "-m anthropic/claude-sonnet-4.6", description: "Model override for this invocation" },
  { flag: "--provider openrouter", description: "Provider override" },
  { flag: "-t web,files", description: "Comma-separated toolsets to enable" },
  { flag: "--yolo", description: "Bypass dangerous-command approval prompts" },
  { flag: "--worktree", description: "Run in an isolated git worktree" },
  { flag: "--safe-mode", description: "Disable all customizations (config, rules, plugins, MCP)" },
  { flag: "--skills <name>", description: "Preload one or more skills" },
];

/**
 * Built-in harness: Hermes Agent (Nous Research).
 *
 * Launch shape:
 *   hermes [-m <model>] [--provider <p>] [-t <toolsets>] [preset flags] [extra flags]
 * A bare launch starts interactive chat; which interface (classic REPL vs
 * --tui) is left to the user's own display.interface config. Hermes has no
 * create-time flag for naming its own session, so the subshell's display name
 * is not forwarded.
 *
 * CAVEAT — the `hermes` on PATH is a bash launcher script that execs the venv
 * binary. Subshell launches are safe: `buildHarnessCommand` runs everything
 * through `env -i`, so inherited shell state cannot reach it. But a backend
 * started from a shell that exports SHELLOPTS containing `onecmd` would break
 * the launcher for probe calls like getVersion() (bash exits after the first
 * line). Start subshell's server from a normal shell, or `env -u SHELLOPTS`.
 *
 * NOTE: subshell MCP is NOT auto-injected. Hermes reads MCP servers only from the
 * fixed ~/.hermes/config.yaml (no --config flag / env override exists), so a
 * per-subshell file is impossible. mcpSetup() surfaces a one-time `hermes mcp
 * add` command instead; the registration is subshell-correct on shared hosts
 * because the subshell-mcp child inherits each subshell's baked SUBSHELL_* env.
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: PluginFactory = (host: PluginHost): SubshellPlugin => ({
  capabilities: (): PluginCapability[] => ["mcp", "settings"],

  /**
   * Hermes prints a banner, not a bare version: "Hermes Agent v0.16.0
   * (2026.6.5) - upstream 5e01a5db" over several lines. Take the first
   * non-empty line, then the semver inside it, falling back to the whole line
   * when there is none.
   */
  parseVersion(raw: string): string | null {
    const firstLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    if (!firstLine) return null;
    const match = firstLine.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : firstLine;
  },

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, extraFlags } = input;
    const args: string[] = [binary];

    const s = preset.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("-m", s.model);
    if (typeof s.provider === "string" && s.provider) args.push("--provider", s.provider);
    if (typeof s.toolsets === "string" && s.toolsets) args.push("-t", s.toolsets);

    // Each stored flag is one complete argv token (see opencode.ts note).
    for (const flag of preset.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  },

  /**
   * Manual, one-time registration (verified against the installed hermes CLI:
   * `hermes mcp add` is non-interactive and writes the global config itself).
   * Hermes has no per-subshell config override, so this registration covers all
   * hermes subshells at once; each `subshell mcp` child inherits its pane's baked
   * SUBSHELL_* env, making the single entry per-subshell-correct. The `--args`
   * flag must come last (hermes' own parser requirement).
   */
  mcpSetup(launch: McpLaunchSpec): McpSetupInfo {
    const argsPart = launch.args.length ? ` --args ${launch.args.map((a) => host.shellQuote(a)).join(" ")}` : "";
    return {
      mode: "manual",
      steps: [
        {
          label: `Register ${MCP_SERVER_NAME} once (adds it to ~/.hermes/config.yaml):`,
          command: `hermes mcp add ${MCP_SERVER_NAME} --command ${host.shellQuote(launch.command)}${argsPart}`,
        },
        { label: "Remove later with:", command: `hermes mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  },

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
  },

  presetSettings(): SettingsField[] {
    return HERMES_SETTINGS_FIELDS;
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
