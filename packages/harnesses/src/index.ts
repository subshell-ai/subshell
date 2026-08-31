import { ClaudeCodePlugin } from "./claude-code.js";
import { HermesPlugin } from "./hermes.js";
import { OpencodePlugin } from "./opencode.js";
import { PiPlugin } from "./pi.js";
import type { HarnessPlugin } from "./types.js";

/**
 * Built-in harness registry. New harnesses are added here (static imports
 * only — no dynamic imports, per repo convention).
 */
export const ALL_HARNESSES: HarnessPlugin[] = [
  new ClaudeCodePlugin(),
  new OpencodePlugin(),
  new HermesPlugin(),
  new PiPlugin(),
];

/** The app's display list/registry helper. */
export function getHarness(id: string): HarnessPlugin | undefined {
  return ALL_HARNESSES.find((h) => h.id === id);
}

export { ClaudeCodePlugin } from "./claude-code.js";
export { HermesPlugin } from "./hermes.js";
export { OpencodePlugin } from "./opencode.js";
export { PiPlugin } from "./pi.js";
export { shellQuote } from "./shell.js";
export { TmuxRunner, tmuxSocketFor } from "./tmux-runner.js";
export type {
  BuildCommandInput,
  HarnessPlugin,
  HarnessResume,
  InstallHint,
  McpLaunchSpec,
  McpRegistration,
  McpSetupInfo,
  McpSetupStep,
  ProfileDefinition,
  ProfileValidationIssue,
  ProfileValidationResult,
  SettingsField,
} from "./types.js";
export { validateGenericProfile } from "./validate.js";
