import { loadConfig, saveConfig } from "./config.js";
import { agentLogFile } from "./log.js";
import type { LevelledTransport } from "./log-file.js";

/**
 * The agent's debug-logging switch — the node half of the server's own
 * (`apps/server/api/src/services/logging-preference.ts`, spec § 3.4).
 *
 * Off by default, applied LIVE by flipping the FILE transport's level, with
 * the environment able to force it on and make the switch read-only. Same
 * shape, same rules, same wording as the server's, because an operator
 * reading one should not have to learn the other.
 *
 * **What it reveals today is nothing, and that is deliberate** (operator's
 * call): the agent has no `logger.debug` call sites. The server's switch has a
 * real payload — `@loglayer/elysia` writes one line per HTTP request at debug
 * — and the agent serves no HTTP, so there is no equivalent stream to hide.
 * This is the mechanism in place, ready for the first debug line anyone
 * writes; it is not a claim that flipping it shows you something.
 */

/** Where the effective debug state comes from. */
export type DebugLoggingSource = "process env" | "setting" | "default";

/** The effective debug state and its layer. */
export interface DebugLoggingState {
  /** Whether debug-level lines reach the agent's log file. */
  debug: boolean;
  /** `process env` means `SUBSHELL_DEBUG_LOGGING` forces it and the switch is read-only. */
  source: DebugLoggingSource;
}

/**
 * Env forces on (and read-only); else the stored boolean; else off. Pure, and
 * takes its env so a test can pin every branch without touching the process.
 *
 * Only truthy spellings force: `SUBSHELL_DEBUG_LOGGING=0` is not "the
 * environment says off", it is someone having left the variable behind, and
 * making it read-only-off would take the switch away with nothing to show for
 * it. The server's rule, to the letter.
 */
export function debugLoggingState(
  env: NodeJS.ProcessEnv = process.env,
  stored: boolean | null = null,
): DebugLoggingState {
  const forced = env.SUBSHELL_DEBUG_LOGGING === "1" || env.SUBSHELL_DEBUG_LOGGING === "true";
  if (forced) return { debug: true, source: "process env" };
  if (stored === null) return { debug: false, source: "default" };
  return { debug: stored, source: "setting" };
}

/**
 * Flip the FILE transport's level. The console transport is never touched:
 * what journald or launchd collects stays at `info` whatever this says.
 */
export function applyDebugLogging(debug: boolean, transport: LevelledTransport = agentLogFile): void {
  transport.level = debug ? "debug" : "info";
}

/** The last value read from or written to the config; null = the field is absent. */
let stored: boolean | null = null;

/** The effective state right now, for the runtime report. */
export function currentDebugLogging(env: NodeJS.ProcessEnv = process.env): DebugLoggingState {
  return debugLoggingState(env, stored);
}

/**
 * Boot: read the persisted flag and apply it. The environment still wins.
 *
 * Persisted rather than per-process, because the sessions worth debugging are
 * the ones that end in a restart — `service restart` is two clicks away on the
 * same card as this switch, and a flag that reset there would turn debugging a
 * crash loop into a race.
 *
 * A machine with no config yet (never enrolled) simply has nothing stored;
 * that is not an error, and the daemon must not fail to start over it.
 */
export async function loadAndApplyDebugLogging(): Promise<void> {
  try {
    stored = (await loadConfig()).debugLogging ?? null;
  } catch {
    stored = null;
  }
  applyDebugLogging(currentDebugLogging().debug);
}

/**
 * Set and persist the flag, then apply it.
 *
 * Refuses while the environment forces it, the way the server's route 409s:
 * writing a value the next read would mask is a success report for a change
 * that never happens.
 */
export async function setDebugLogging(debug: boolean): Promise<DebugLoggingState> {
  if (currentDebugLogging().source === "process env") {
    throw new Error(
      "SUBSHELL_DEBUG_LOGGING is set in this agent's environment, so debug logging cannot be changed here",
    );
  }
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, debugLogging: debug });
  stored = debug;
  applyDebugLogging(debug);
  return currentDebugLogging();
}

/**
 * Drop the memoized value. For tests only.
 * @internal
 */
export function resetDebugLoggingForTests(): void {
  stored = null;
}
