import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { type LevelledTransport, serverLogFile } from "@/utils/log-file.js";

/**
 * The debug-logging switch (spec § 3.4): an instance setting, off by default,
 * applied LIVE by flipping the file transport's level — no restart. The
 * environment can force it on for a headless box or for the lines written
 * before the database is open, and while it does the setting is read-only.
 */

/** The `settings` row that stores it; an absent row means off. */
export const DEBUG_LOGGING_KEY = "debug_logging";

/** Where the effective debug state comes from. */
export type DebugLoggingSource = "process env" | "setting" | "default";

/** The effective debug state and its layer. */
export interface DebugLoggingState {
  /** Whether debug-level lines and HTTP request lines reach the log file. */
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
 * it.
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
 * Flip the FILE transport's level. stdout is never touched: what the service
 * manager collects stays at `info` whatever this says (spec § 3.4).
 */
export function applyDebugLogging(debug: boolean, transport: LevelledTransport = serverLogFile): void {
  transport.level = debug ? "debug" : "info";
}

/** The last value read from or written to the settings row; null = no row. */
let stored: boolean | null = null;

/** Boot: read the setting once the database is open, and apply it. The environment still wins. */
export async function loadAndApplyDebugLogging(): Promise<void> {
  stored = await new SettingsRepository(db).get<boolean | null>(DEBUG_LOGGING_KEY, null);
  applyDebugLogging(debugLoggingState(process.env, stored).debug);
}

/**
 * The route's body: persist, remember, apply. Callers have already refused the
 * env-forced case — writing a row the environment overrides would report a
 * success the next log line contradicts.
 */
export async function setDebugLogging(debug: boolean): Promise<void> {
  await new SettingsRepository(db).set(DEBUG_LOGGING_KEY, debug);
  stored = debug;
  applyDebugLogging(debug);
}

/** The effective state, for the deployment view. */
export function currentDebugLogging(): DebugLoggingState {
  return debugLoggingState(process.env, stored);
}

/**
 * Drop the remembered setting. Only for tests that need a fresh read.
 * @internal
 */
export function resetDebugLoggingForTests(): void {
  stored = null;
}
