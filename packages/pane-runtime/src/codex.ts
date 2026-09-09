import { validateGenericProfile } from "@subshell-ai/plugin-api";
import { type DetectionResult, detectBinary } from "./binary-lookup.js";
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
import { probeVersion } from "./version-probe.js";

/** Known Codex settings, applied as per-invocation CLI flags. */
const CODEX_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "model",
    label: "Model",
    description: "Model name passed as -m/--model (e.g. 'gpt-5-codex')",
    type: "string",
  },
  {
    key: "sandbox",
    label: "Sandbox",
    description: "What the agent may touch without asking (-s/--sandbox)",
    type: "select",
    choices: ["read-only", "workspace-write", "danger-full-access"],
  },
  {
    key: "askForApproval",
    label: "Ask for approval",
    description: "When codex pauses for a human decision (-a/--ask-for-approval)",
    type: "select",
    choices: ["on-request", "never"],
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  // CODEX_HOME is deliberately NOT suggested: it locates ~/.codex, which
  // holds the user's auth.json — pointing it elsewhere logs the subshell out
  // of ChatGPT and hides their config.toml. subshell never needs it: its MCP
  // wiring rides per-invocation `-c` overrides (mcpRegistration), so the
  // user's own dir is used as-is.
  { key: "OPENAI_API_KEY", description: "API key for the api-key login mode (else ChatGPT sign-in)" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--search", description: "Enable live web search" },
  { flag: "-p work", description: "Apply a profile from ~/.codex/config.toml" },
  {
    flag: '-c mcp_servers.foo.command="/usr/bin/foo"',
    description: "One-off config override (dotted path, value parsed as TOML)",
  },
];

// HOME-relative fallbacks (findBinary joins these to $HOME — absolute paths
// would NOT reset the join, so brew/npm-global system dirs come via PATH).
const PLUGIN_KNOWN_PATHS = [".local/bin/codex", ".npm-global/bin/codex", ".bun/bin/codex"];

/** A TOML basic string from an ASCII-safe JS string. */
function tomlString(value: string): string {
  // JSON.stringify emits exactly TOML's basic-string syntax for these shapes
  // (same `"` delimiter, same `\"`/`\\`/`\n` escapes) — command paths and argv
  // tokens are filesystem-safe by construction, so the encodings coincide.
  return JSON.stringify(value);
}

/** A TOML inline array of basic strings — same JSON-compatibility argument. */
function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/**
 * Built-in harness: Codex (OpenAI's `@openai/codex` CLI).
 *
 * Launch shape:
 *   codex [-m <model>] [-s <sandbox>] [-a <approval>] [mcp -c pairs]
 *         [profile flags] [extra flags]
 * A bare launch (no subcommand, no prompt) opens the interactive TUI. Codex
 * has no create-time flag for naming its own session and no way to pin a
 * conversation id, so neither the subshell name nor a resume capability is
 * forwarded — restarts start a fresh conversation (the documented default).
 * The pane's
 * cwd is already the working directory, so `-C/--cd` is never passed, and
 * `--dangerously-bypass-approvals-and-sandbox` is NEVER baked into a launch
 * (a user may put it in their own profile flags — that is their call).
 *
 * subshell MCP is wired automatically WITHOUT touching user state: every
 * launch carries `-c mcp_servers.subshell.command=… -c mcp_servers.subshell.args=…`
 * config overrides (dotted path, value parsed as TOML — verified against the
 * real binary), which codex merges over ~/.codex/config.toml for that run
 * only. No config file the harness must read, no CODEX_HOME redirect (that
 * dir holds the user's auth.json). The spawned `subshell mcp` child inherits
 * the subshell's baked SUBSHELL_* pane env for its credential, like every
 * harness.
 * (Flags/values verified against @openai/codex 2026-09 help output.)
 */
export class CodexPlugin implements HarnessPlugin {
  readonly id = "codex";
  readonly name = "Codex";
  readonly binaryName = "codex";
  readonly description = "OpenAI's agentic coding CLI (interactive TUI)";
  readonly icon = "📖";
  readonly ttyRequired = true;
  readonly enabledByDefault = true;
  readonly installHint = {
    // Official standalone installer (also `npm install -g @openai/codex`).
    command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    docsUrl: "https://learn.chatgpt.com/docs/codex/cli",
  };

  /** Binary override; injectable for tests. */
  readonly #binaryOverride: string | null;

  constructor(binaryOverride: string | null = null) {
    this.#binaryOverride = binaryOverride;
  }

  async detect(): Promise<DetectionResult> {
    if (this.#binaryOverride) {
      // An injected override that does not exist is the same class of mistake
      // as a bad CODEX_PATH: the caller said where it is and was wrong.
      return (await Bun.file(this.#binaryOverride).exists())
        ? { path: this.#binaryOverride }
        : { path: null, reason: "override-invalid" };
    }
    return detectBinary(this.binaryName, "CODEX_PATH", PLUGIN_KNOWN_PATHS);
  }

  async findBinary(): Promise<string | null> {
    return (await this.detect()).path;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.detect()).path !== null;
  }

  async getVersion(): Promise<string | null> {
    const binary = await this.findBinary();
    return binary ? await probeVersion(binary) : null;
  }

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, extraFlags, mcp } = input;
    const args: string[] = [binary];

    const s = profile.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("-m", s.model);
    if (typeof s.sandbox === "string" && s.sandbox) args.push("-s", s.sandbox);
    if (typeof s.askForApproval === "string" && s.askForApproval) args.push("-a", s.askForApproval);

    // Subshell channels + subshell orchestration: the registration's own argv
    // (-c mcp_servers.subshell.* overrides — see mcpRegistration) splices here.
    if (mcp?.args) args.push(...mcp.args);

    // Each stored flag is one complete argv token (row editor guarantees it);
    // never re-split on whitespace or multi-word values break.
    for (const flag of profile.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  }

  /**
   * Codex config fragment registering subshell as a stdio MCP server — the
   * exact `[mcp_servers.subshell]` block `~/.codex/config.toml` expects. The
   * block is NOT what activates the server on subshell launches: `buildCommand`
   * splices live `-c` overrides instead (see the class doc), so this file is a
   * manual-setup reference a user may append to their own config.
   */
  mcpRegistration(launch: McpLaunchSpec, _configPath: string): McpRegistration {
    const fragment = [
      "# Subshell: cross-subshell MCP server, in the shape ~/.codex/config.toml expects.",
      "#",
      "# This file is a MANUAL-SETUP REFERENCE ONLY: subshell's own launches pass the",
      "# live values as `-c mcp_servers.subshell.*=…` per-invocation overrides, so codex",
      "# never reads this file. To register subshell permanently (e.g. terminal codex),",
      "# append the block below to ~/.codex/config.toml.",
      "",
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `command = ${tomlString(launch.command)}`,
      `args = ${tomlStringArray(launch.args)}`,
      "",
    ].join("\n");
    return {
      fileContent: fragment,
      args: [
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(launch.command)}`,
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.args=${tomlStringArray(launch.args)}`,
      ],
      // No wiring env on purpose (contrast opencode's OPENCODE_CONFIG): the -c
      // argv IS the wiring, and CODEX_HOME must stay on the user's dir (auth).
      // The spawned `subshell mcp` child inherits the SUBSHELL_* credentials
      // the backend bakes into the pane regardless of this registration.
      env: undefined,
    };
  }

  /** Auto: `buildCommand` wires `-c mcp_servers.subshell.*` into every subshell. */
  mcpSetup(_launch: McpLaunchSpec): McpSetupInfo {
    return {
      mode: "auto",
      summary:
        "Subshell registers itself with every Codex subshell automatically (per-invocation -c mcp_servers.subshell.* overrides; your ~/.codex config is never modified).",
    };
  }

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  }

  settingsFields(): SettingsField[] {
    return CODEX_SETTINGS_FIELDS;
  }

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  }

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  }
}
