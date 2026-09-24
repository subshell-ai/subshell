import { loadConfig, type NodeConfig, updateConfig } from "./config.js";
import { type LogRetentionState, resolveLogRetentionState } from "./pane-log-retention.js";

/**
 * The node's pane-log retention SETTER — the machine editing its own window,
 * behind the loopback dashboard's `PUT /api/self/log-retention`.
 *
 * The shape is `debug-logging.ts`'s, per field: read the layers honestly,
 * persist to `config.json`, and refuse while the environment forces the value,
 * because a write the next read would mask is a success report for a change
 * that never happens. Two details differ from that precedent, and each has a
 * reason:
 *
 * - **Refusals are answers, not throws.** Debug logging has one refusal
 *   (env-forced) so its route maps the single error to a 409; this setter
 *   also validates, and a 400 for `days: -3` vs a 409 for an env-forced field
 *   is a distinction the caller should keep. A result union carries it.
 * - **The whole write is atomic.** A request naming both fields where one is
 *   env-forced stores NOTHING. Writing the allowed half and refusing the other
 *   would answer one status for two outcomes; the operator retries the
 *   writable half alone and gets a clean yes for it.
 *
 * There is no memoized `stored` like debug logging's: for a live transport
 * level the in-memory value IS the state, but the truth here is a file the
 * daemon re-reads every pass (`createRetentionPass`), so reading config.json
 * fresh per request cannot disagree with anything.
 */

/**
 * Whether THIS process has the hourly sweep armed — a PROCESS fact, stated
 * once by the daemon from its boot resolution (round-3 review, finding 5).
 *
 * The header says this module keeps no memo of the WINDOW, and that stands:
 * the window's truth is the file the pass re-reads. This is the other kind of
 * fact — no file can answer it. The boot resolution arms the hourly timer or
 * skips it (keep-forever schedules nothing), and nothing re-arms it later;
 * every later save lands only where a pass exists to read it. The card must
 * therefore distinguish "your change applies at the next sweep" from "your
 * change waits for a restart", and only the process that decided the schedule
 * knows which one it is saying. `false` is also the honest answer when no
 * daemon runs at all (a standalone `subshell dashboard` sweeps nothing,
 * timer or not).
 */
let sweepScheduled = false;

/** The daemon states its boot decision. Production calls this exactly once. @internal seam for tests too. */
export function noteSweepScheduled(scheduled: boolean): void {
  sweepScheduled = scheduled;
}

/** What the dashboard's retention endpoints answer beside the window. */
export function sweepIsScheduled(): boolean {
  return sweepScheduled;
}

/**
 * A requested change, BEFORE validation: the dashboard hands the module the
 * raw body fields, so `unknown` is honest about what arrives and this module
 * is the one place the value becomes a number or a refusal.
 */
export interface RetentionWrite {
  days?: unknown;
  hours?: unknown;
}

/** A refused write, with the status the route answers and the sentence it carries. */
export type RetentionSetResult =
  | { ok: true; state: LogRetentionState }
  | { ok: false; status: 400 | 409; message: string };

const ENV_NAME: Record<keyof RetentionWrite, string> = {
  days: "SUBSHELL_LOG_RETENTION_DAYS",
  hours: "SUBSHELL_LOG_RETENTION_HOURS",
};

/** The effective window right now, read fresh: what the dashboard renders. */
export async function readRetentionState(env: NodeJS.ProcessEnv = process.env): Promise<LogRetentionState> {
  // No config (never enrolled, or unreadable) is the all-defaults answer, not
  // an error: the dashboard's own routes are built from a loaded config, so a
  // throw here only races an unenroll, and the defaults are what a node with
  // no config would sweep with.
  const cfg = await loadConfig().catch(() => undefined);
  return resolveLogRetentionState(env, cfg ?? {});
}

/**
 * Validate one written field by `config.ts`'s `retentionField` rule (a
 * non-negative integer; `0` is real, it is half of keep-forever) — raised
 * from a junk-drop to a refusal, because a junk value in a WRITE is an
 * explicit request, not a field to silently drop to the default.
 */
function checkField(field: keyof RetentionWrite, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return `Retention ${field} must be a non-negative integer (got ${JSON.stringify(value) ?? String(value)}); 0 is allowed, and 0 days + 0 hours together keep every log forever.`;
  }
  return null;
}

/**
 * Persist a window change to `config.json`.
 *
 * The environment check reads the field's LAYER, not a value: env answers (a
 * parseable value) ⇒ refuse; a blank or junky env spelling answers nothing
 * (the resolution warns and falls through) ⇒ allow, because the write the
 * caller asks for is the one the daemon will actually use.
 */
export async function setLogRetention(
  write: RetentionWrite,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetentionSetResult> {
  const fields = (["days", "hours"] as const).filter((f) => write[f] !== undefined);
  if (fields.length === 0) {
    return { ok: false, status: 400, message: "Nothing to change: give days and/or hours." };
  }
  for (const f of fields) {
    const problem = checkField(f, write[f] as number);
    if (problem) return { ok: false, status: 400, message: problem };
  }
  const state = await readRetentionState(env);
  for (const f of fields) {
    if (state[f].forced) {
      return {
        ok: false,
        status: 409,
        message: `${ENV_NAME[f]} is set in this agent's environment, so the retention ${f} cannot be changed here`,
      };
    }
  }
  let merged: NodeConfig;
  try {
    // Keep every other field — this file is the node key's only home. NOT a
    // whole-file rewrite over the snapshot read a moment ago, but
    // `updateConfig`'s fresh re-read with only the WRITTEN fields named
    // (round-3 review, finding 3): a debug-logging flip landing between the
    // state read above and this save survives it, and the reverse is true.
    const patch: Partial<Pick<NodeConfig, "logRetentionDays" | "logRetentionHours">> = {};
    if (fields.includes("days")) patch.logRetentionDays = write.days as number;
    if (fields.includes("hours")) patch.logRetentionHours = write.hours as number;
    merged = await updateConfig(patch);
  } catch (err) {
    return {
      ok: false,
      status: 409,
      message: `This machine's node config could not be read to be updated: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, state: resolveLogRetentionState(env, merged) };
}
