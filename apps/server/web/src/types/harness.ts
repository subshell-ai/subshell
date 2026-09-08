/**
 * A harness plugin as reported by `GET /api/setup/harnesses` — the shape the
 * setup wizard and the profile forms read (harness enablement itself lives
 * per node, `/nodes/:id`).
 */
export interface HarnessInfo {
  /** Plugin id, e.g. "claude-code" — stored on profiles as `harnessId` */
  id: string;
  /** Human-readable name, e.g. "Claude Code" */
  name: string;
  /** Executable command name, e.g. "claude" — what a launch command starts with */
  binary: string;
  /** One-line description of the harness */
  description: string;
  /** Emoji/glyph for the harness, when it has one */
  icon?: string;
  /** True when the CLI is on the machine's PATH */
  installed: boolean;
  /** Detected CLI version, when installed */
  version?: string;
  /** True when enabled for use */
  enabled: boolean;
  /** Official install instructions, shown when detection fails */
  install: { command: string; docsUrl: string };
}

/**
 * One option in a harness's settings schema, as served by
 * `GET /api/profiles/harnesses/:id/schema`. No editor renders these yet —
 * flags cover the same ground from the profile UI.
 */
export interface SettingsFieldInfo {
  /** Key into the settings object, e.g. "permissionMode" */
  key: string;
  /** Property label */
  label: string;
  /** Short description for an editor */
  description?: string;
  /** Editor control kind */
  type: "string" | "boolean" | "number" | "select";
  /** Choices when type is "select" */
  choices?: string[];
  /** Default value when unset */
  default?: string | boolean | number;
}

/** One copy-paste step in a harness's manual cross-subshell-comms setup. */
export interface McpSetupStepInfo {
  /** What the user should do / where the text goes */
  label: string;
  /** Copyable command or JSON snippet */
  command: string;
}

/**
 * How a harness obtains the `subshell mcp` cross-subshell tools. Discriminated:
 * auto carries a summary, manual carries steps (mirrors the API's union).
 */
export type McpSetupInfo = { mode: "auto"; summary: string } | { mode: "manual"; steps: McpSetupStepInfo[] };

/** Reference data for one harness, backing the profile editor's suggestions. */
export interface HarnessSchema {
  /** Settings editor schema (empty when the harness has none) */
  settingsFields: SettingsFieldInfo[];
  /** Known env vars with one-line descriptions */
  suggestedEnv: { key: string; description: string }[];
  /** Known CLI flags with one-line descriptions */
  suggestedFlags: { flag: string; description: string }[];
  /** How this harness gets cross-subshell comms (auto vs one-time manual setup) */
  mcp: McpSetupInfo;
}
