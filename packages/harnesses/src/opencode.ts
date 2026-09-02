import { findBinary } from "./binary-lookup.js";
import type {
  BuildCommandInput,
  HarnessPlugin,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  ProfileDefinition,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
import { MCP_SERVER_NAME } from "./types.js";
import { validateGenericProfile } from "./validate.js";

/** Known opencode settings, applied as per-invocation CLI flags. */
const OPENCODE_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "model",
    label: "Model",
    description: "Model in provider/model form (e.g. 'anthropic/claude-sonnet-4-5')",
    type: "string",
  },
  {
    key: "agent",
    label: "Agent",
    description: "Agent to use for the session",
    type: "string",
  },
  {
    key: "auto",
    label: "Auto-approve permissions",
    description: "Approve permissions that are not explicitly denied (dangerous)",
    type: "boolean",
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  // OPENCODE_CONFIG is deliberately NOT suggested: subshell owns it — it points
  // at each session's generated MCP config layer (mcpRegistration), and a
  // profile that set it would shadow its own cross-session comms. Users who
  // want their own extra layer use OPENCODE_CONFIG_CONTENT (independent merge
  // source) or OPENCODE_CONFIG_DIR.
  { key: "OPENCODE_CONFIG_CONTENT", description: "Inline JSON config merged at runtime" },
  { key: "OPENCODE_CONFIG_DIR", description: "Extra config dir (agents/commands/plugins) — isolation knob" },
  { key: "OPENCODE_TUI_CONFIG", description: "Path to a custom TUI config file" },
  { key: "OPENCODE_API_KEY", description: "OpenCode Zen / OpenCode Go API key" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "-m anthropic/claude-sonnet-4-5", description: "Model in provider/model form" },
  { flag: "--agent plan", description: "Start with a specific agent" },
  { flag: "--auto", description: "Auto-approve permissions not explicitly denied" },
  { flag: "--pure", description: "Run without external plugins" },
  { flag: "--prompt <text>", description: "Initial prompt for the session" },
  { flag: "--mini", description: "Start the minimal interactive interface" },
  { flag: "--print-logs", description: "Print logs to stderr (helps debugging)" },
];

const PLUGIN_KNOWN_PATHS = [".opencode/bin/opencode"];

/**
 * Built-in harness: OpenCode (opencode.ai).
 *
 * Launch shape:
 *   opencode [-m <model>] [--agent <a>] [--auto] [profile flags] [extra flags]
 * A bare launch opens the TUI. opencode has no create-time session-name flag,
 * so the subshell session name is deliberately not forwarded. Settings arrive as
 * per-invocation flags (verified against opencode 1.18.18).
 *
 * subshell MCP is wired automatically: OpenCode merges any object under the
 * OPENCODE_CONFIG env-var path into its config (verified against 1.18.18 —
 * "Custom config is loaded between global and project configs", files are
 * merged not replaced). subshell writes a per-session config file holding just an
 * `mcp.subshell` local stdio entry and points OPENCODE_CONFIG at it, so the user's
 * own global/project servers are preserved. The spawned `subshell mcp` child
 * inherits the session's baked SUBSHELL_* env for its credential.
 */
export class OpencodePlugin implements HarnessPlugin {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly binaryName = "opencode";
  readonly description = "Open-source omnichannel agentic coding CLI (interactive TUI)";
  readonly icon = "✳️";
  readonly ttyRequired = true;
  readonly enabledByDefault = true;
  readonly installHint = {
    command: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs/cli/",
  };

  /** Binary override; injectable for tests. */
  readonly #binaryOverride: string | null;

  constructor(binaryOverride: string | null = null) {
    this.#binaryOverride = binaryOverride;
  }

  async findBinary(): Promise<string | null> {
    if (this.#binaryOverride) {
      return (await Bun.file(this.#binaryOverride).exists()) ? this.#binaryOverride : null;
    }
    return findBinary(this.binaryName, "OPENCODE_PATH", PLUGIN_KNOWN_PATHS);
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findBinary()) !== null;
  }

  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    if (!binary) return null;
    try {
      const proc = Bun.spawn({ cmd: [binary, "--version"], stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, extraFlags } = input;
    const args: string[] = [binary];

    const s = profile.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("-m", s.model);
    if (typeof s.agent === "string" && s.agent) args.push("--agent", s.agent);
    if (s.auto === true) args.push("--auto");

    // Each stored flag is one complete argv token (row editor guarantees it);
    // never re-split on whitespace or multi-word values break.
    for (const flag of profile.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  }

  /**
   * OpenCode config fragment registering subshell as a local stdio MCP server.
   * Merged (not replaced) into the user's config via the OPENCODE_CONFIG env
   * var — see the class doc. `command` is the argv array OpenCode expects.
   */
  mcpRegistration(launch: McpLaunchSpec, configPath: string): McpRegistration {
    const doc = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [MCP_SERVER_NAME]: { type: "local", command: [launch.command, ...launch.args], enabled: true },
      },
    };
    return { fileContent: `${JSON.stringify(doc, null, 2)}\n`, env: { OPENCODE_CONFIG: configPath } };
  }

  /** Auto: subshell writes a merged config layer + OPENCODE_CONFIG for every session. */
  mcpSetup(_launch: McpLaunchSpec): McpSetupInfo {
    return {
      mode: "auto",
      summary:
        "Subshell registers itself with every OpenCode session automatically (a merged config layer + OPENCODE_CONFIG).",
    };
  }

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  }

  settingsFields(): SettingsField[] {
    return OPENCODE_SETTINGS_FIELDS;
  }

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  }

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  }
}
