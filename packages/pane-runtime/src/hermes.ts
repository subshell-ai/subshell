import { validateGenericProfile } from "@subshell-ai/plugin-api";
import { type DetectionResult, detectBinary } from "./binary-lookup.js";
import { shellQuote } from "./shell.js";
import type {
  BuildCommandInput,
  HarnessPlugin,
  McpLaunchSpec,
  McpSetupInfo,
  ProfileDefinition,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
import { MCP_SERVER_NAME } from "./types.js";
import { probeVersion } from "./version-probe.js";

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

const PLUGIN_KNOWN_PATHS = [".local/bin/hermes"];

/**
 * Built-in harness: Hermes Agent (Nous Research).
 *
 * Launch shape:
 *   hermes [-m <model>] [--provider <p>] [-t <toolsets>] [profile flags] [extra flags]
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
 */
export class HermesPlugin implements HarnessPlugin {
  readonly id = "hermes";
  readonly name = "Hermes Agent";
  readonly binaryName = "hermes";
  readonly description = "Nous Research's open agent CLI (interactive chat)";
  readonly icon = "📮";
  readonly ttyRequired = true;
  readonly enabledByDefault = true;
  readonly installHint = {
    command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  };

  /** Binary override; injectable for tests. */
  readonly #binaryOverride: string | null;

  constructor(binaryOverride: string | null = null) {
    this.#binaryOverride = binaryOverride;
  }

  async detect(): Promise<DetectionResult> {
    if (this.#binaryOverride) {
      // An injected override that does not exist is the same class of mistake
      // as a bad HERMES_PATH: the caller said where it is and was wrong.
      return (await Bun.file(this.#binaryOverride).exists())
        ? { path: this.#binaryOverride }
        : { path: null, reason: "override-invalid" };
    }
    return detectBinary(this.binaryName, "HERMES_PATH", PLUGIN_KNOWN_PATHS);
  }

  async findBinary(): Promise<string | null> {
    return (await this.detect()).path;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.detect()).path !== null;
  }

  /**
   * Hermes prints a multi-line block whose first line is a label like
   * "Hermes Agent v0.16.0 (2026.6.5) · upstream 5e01a5db". Return just the
   * version number so the UI can prefix it with a single "v" (falling back
   * to the whole first line if no semver is present).
   */
  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    if (!binary) return null;
    const out = await probeVersion(binary);
    if (!out) return null;
    const firstLine =
      out
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) ?? null;
    if (!firstLine) return null;
    const match = firstLine.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : firstLine;
  }

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, extraFlags } = input;
    const args: string[] = [binary];

    const s = profile.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("-m", s.model);
    if (typeof s.provider === "string" && s.provider) args.push("--provider", s.provider);
    if (typeof s.toolsets === "string" && s.toolsets) args.push("-t", s.toolsets);

    // Each stored flag is one complete argv token (see opencode.ts note).
    for (const flag of profile.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  }

  /**
   * Manual, one-time registration (verified against the installed hermes CLI:
   * `hermes mcp add` is non-interactive and writes the global config itself).
   * Hermes has no per-subshell config override, so this registration covers all
   * hermes subshells at once; each `subshell mcp` child inherits its pane's baked
   * SUBSHELL_* env, making the single entry per-subshell-correct. The `--args`
   * flag must come last (hermes' own parser requirement).
   */
  mcpSetup(launch: McpLaunchSpec): McpSetupInfo {
    const argsPart = launch.args.length ? ` --args ${launch.args.map(shellQuote).join(" ")}` : "";
    return {
      mode: "manual",
      steps: [
        {
          label: `Register ${MCP_SERVER_NAME} once (adds it to ~/.hermes/config.yaml):`,
          command: `hermes mcp add ${MCP_SERVER_NAME} --command ${shellQuote(launch.command)}${argsPart}`,
        },
        { label: "Remove later with:", command: `hermes mcp remove ${MCP_SERVER_NAME}` },
      ],
    };
  }

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  }

  settingsFields(): SettingsField[] {
    return HERMES_SETTINGS_FIELDS;
  }

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  }

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  }
}
