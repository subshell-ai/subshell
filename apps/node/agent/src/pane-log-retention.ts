import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TmuxRunner } from "@internal/pane-runtime";
import type { NodeConfig } from "./config.js";
import { log } from "./log.js";
import { pathAllowed } from "./path-policy.js";
import { isSubshellId, type SubshellMetaStore } from "./subshell-meta.js";

/**
 * Node-side pane-log retention — the agent's own sweep over
 * `<dataDir>/subshells/<id>.log`, the machine's copy of the rule the server
 * has run since `services/pane-log-hygiene.ts` (operator ruling 2026-09-23).
 *
 * **Why this exists on the node at all.** A pane log is the verbatim typed
 * transcript, pasted tokens included (threat model: `docs/security.md`,
 * "Pane logs"). Before this, the only node-side deletion was the plane
 * commanding `remove_paths` at delete time — a node that was OFFLINE for the
 * delete kept the transcript indefinitely, and a terminated-but-kept
 * subshell held it for the life of the machine. Retention that lives only on
 * the control plane is retention the machine's own disk never sees.
 *
 * Three rules, each inherited from the server's sweep:
 *
 * - **A running subshell's log is never swept**, whatever the mtime says —
 *   it is the live replay buffer, and a quiet pane still has viewers
 *   replaying from that file. Liveness is re-probed per file immediately
 *   before unlinking, because a restart lands inside the census→unlink
 *   window and reuses the path append-only with the old mtime intact.
 * - **`0 days + 0 hours` is keep-forever**, the documented opt-out (the
 *   server's `SUBSHELL_LOG_RETENTION_DAYS=0` spelling, widened with an hours
 *   half so a node owner can choose a window shorter than a day). A
 *   misread negative can never mean "delete everything".
 * - **Unknown is not dead.** `TmuxRunner.hasSubshell` throws
 *   `TmuxTimeoutError` when tmux did not answer; a sweep is destructive, so
 *   an unanswerable probe counts the pane as RUNNING. `false` is an answer,
 *   and ages the file out.
 *
 * Liveness is the same census `subshell maintenance on` uses — every
 * meta record probed by name — NOT the exit watcher's in-process
 * registrations: panes survive an agent restart, and the sweep must believe
 * the socket, not this process's memory. The probes run CONCURRENTLY
 * ({@link CENSUS_CONCURRENCY} at a time) rather than back to back: production
 * mints one tmux socket per subshell, so the exit watcher's per-socket batch
 * would still be one spawn per record here, and what a wedged host actually
 * costs this sweep is SERIALITY — serial, N wedged panes meant N × the 15 s
 * tmux timeout; concurrent, the census wall-time is one timeout's order.
 * The per-socket `listSubshellsChecked` shape is deliberately NOT adopted
 * either: its `ok:false` collapses "the server is gone" (which `hasSubshell`
 * answers `false`, and is what ages a kept pane's log out after its server
 * dies) with "the server did not answer", and this module's whole safety rule
 * lives on that distinction.
 *
 * The setter surface is **node-local** (R3, 2026-09-23): `retention-settings.ts`
 * + the dashboard's `PUT /api/self/log-retention`, with the environment able
 * to force either field and make it read-only — the `SUBSHELL_DEBUG_LOGGING`
 * rule, per field. It lives under `/api/self/` rather than `/api/nodes/:id/`
 * because the plane has NO counterpart route: the mirrored contract is for
 * cards that run against both backends, and this block runs only on the
 * machine whose files it ages out. A daemon pass re-resolves the stored layer
 * every run ({@link createRetentionPass}), so a dashboard write lands on the
 * next hourly sweep without a restart. There is still no CLI verb: no
 * `subshell config` command exists to extend, and `configure` is deliberately
 * the two plane-address edits and nothing else.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Log file names are `<subshell id>.log`; nothing else in the dir is ours. */
const LOG_SUFFIX = ".log";

/** How often the daemon re-sweeps. A window measured in hours gains nothing from a faster tick. */
export const PANE_LOG_RETENTION_PASS_MS = HOUR_MS;

/**
 * How many liveness probes the census runs at once (round-3 review, finding 2).
 *
 * Concurrent because the census is one probe per meta record and a wedged tmux
 * makes every one of them cost the full 15 s timeout — serial, the sweep's
 * wall-time scaled with the pane count. Capped rather than unbounded because
 * meta records OUTLIVE their panes when the node was offline for the death
 * (nothing forgets them until a death report lands), so the census can face
 * hundreds of names, and a fork storm on a machine whose tmux is already
 * wedged helps nothing recover. Eight is a shape choice, not a measurement:
 * any constant ≥ 2 fixes the scaling; any large one reintroduces the storm.
 */
const CENSUS_CONCURRENCY = 8;

/** The operator's default: one day. Shorter than the server's 30 because a node is not where transcripts should accrete. */
export const DEFAULT_LOG_RETENTION: LogRetention = { days: 1, hours: 0 };

/** A retention window: `days * 24h + hours`; `0 + 0` is the keep-forever pair. */
export interface LogRetention {
  days: number;
  hours: number;
}

/** {@link resolveLogRetention}'s answer: the effective window, plus what it took to get there. */
export interface ResolvedLogRetention extends LogRetention {
  /** `days === 0 && hours === 0`: nothing will ever be swept; the daemon does not even schedule a pass. */
  forever: boolean;
  /** Human lines for env values that were present but unusable. The caller logs them; resolution never throws. */
  problems: string[];
}

/** Which layer answered one field of the window. */
export type RetentionSource = "env" | "stored" | "default";

/** One field of {@link LogRetentionState}: the effective value and who decided it. */
export interface RetentionFieldState {
  value: number;
  source: RetentionSource;
  /**
   * True exactly when `source === "env"`: the environment is forcing this
   * field, so a write to the stored layer would be masked by the next read
   * and the setter must refuse it (`retention-settings.ts`). Per field —
   * env-days forces the days write and says nothing about hours.
   */
  forced: boolean;
}

/** The effective window with the LAYER TRUTH the dashboard renders. */
export interface LogRetentionState {
  days: RetentionFieldState;
  hours: RetentionFieldState;
  forever: boolean;
}

/**
 * Resolve the effective window, PER FIELD: `SUBSHELL_LOG_RETENTION_DAYS` /
 * `SUBSHELL_LOG_RETENTION_HOURS` win over the `config.json` fields, which
 * win over {@link DEFAULT_LOG_RETENTION}. Env wins because that is this
 * product's ladder everywhere ("a value set in the environment must not be
 * masked by a write"); the two fields compose rather than veto each other,
 * so env-days + stored-hours is a coherent window, not a conflict.
 *
 * Pure, and takes its env so a test pins every branch without touching the
 * process. A blank/whitespace env value is the variable having no answer
 * (the `SUBSHELL_DASHBOARD_PORT` precedent), not a bad one; anything else
 * that is not a non-negative integer is reported in `problems` and skipped.
 *
 * @param env - the environment to read (production: `process.env`)
 * @param cfg - the loaded config's retention fields (already junk-filtered
 *   by `loadConfig`; re-checked here because this resolver is the seam)
 */
export function resolveLogRetention(
  env: NodeJS.ProcessEnv,
  cfg: Pick<NodeConfig, "logRetentionDays" | "logRetentionHours">,
): ResolvedLogRetention {
  const problems: string[] = [];
  const days = fieldState(env, cfg, "days", problems);
  const hours = fieldState(env, cfg, "hours", problems);
  return { days: days.value, hours: hours.value, forever: days.value === 0 && hours.value === 0, problems };
}

/**
 * The same resolution, with the layer truth a setter surface renders: which
 * layer answered each field, and (therefore) which writes the environment
 * blocks. {@link resolveLogRetention} stays the sweep's view of the same math
 * — one {@link fieldState} underneath, so the card can never disagree with
 * what the daemon will actually do.
 */
export function resolveLogRetentionState(
  env: NodeJS.ProcessEnv,
  cfg: Pick<NodeConfig, "logRetentionDays" | "logRetentionHours">,
): LogRetentionState {
  const problems: string[] = [];
  const days = fieldState(env, cfg, "days", problems);
  const hours = fieldState(env, cfg, "hours", problems);
  return { days, hours, forever: days.value === 0 && hours.value === 0 };
}

/** One field of the window: the ladder, plus which rung answered. */
function fieldState(
  env: NodeJS.ProcessEnv,
  cfg: Pick<NodeConfig, "logRetentionDays" | "logRetentionHours">,
  field: "days" | "hours",
  problems: string[],
): RetentionFieldState {
  const name = field === "days" ? "SUBSHELL_LOG_RETENTION_DAYS" : "SUBSHELL_LOG_RETENTION_HOURS";
  const envValue = parseEnvValue(env[name], name, problems);
  if (envValue !== undefined) return { value: envValue, source: "env", forced: true };
  const fallback = field === "days" ? DEFAULT_LOG_RETENTION.days : DEFAULT_LOG_RETENTION.hours;
  const stored = field === "days" ? cfg.logRetentionDays : cfg.logRetentionHours;
  if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0)
    return { value: stored, source: "stored", forced: false };
  return { value: fallback, source: "default", forced: false };
}

/** One env spelling: a non-negative integer, `undefined` when the layer did not answer, a problem when it answered badly. */
function parseEnvValue(raw: string | undefined, name: string, problems: string[]): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined; // present with no answer — unset, not a mistake
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${name}="${raw}" is not a non-negative integer; ignored`);
    return undefined;
  }
  return value;
}

/** Inputs to one {@link sweepExpiredPaneLogs} pass. */
export interface PaneLogSweepOptions {
  /** The node's data dir; the sweep touches only `<dataDir>/subshells/<valid-id>.log`. */
  dataDir: string;
  /** The effective window ({@link resolveLogRetention}). */
  retention: LogRetention;
  /** The launch records; `list()` × `hasSubshell` IS "what is alive here" — the maintenance census, same two seams. */
  meta: Pick<SubshellMetaStore, "list">;
  /** Pane liveness. @throws-aware: a probe that cannot answer counts the pane alive. */
  tmux: Pick<TmuxRunner, "hasSubshell">;
  /** Epoch-ms clock, injectable so the age boundary is testable. */
  nowMs?: number;
}

/** What one pass removed. */
export interface PaneLogSweepResult {
  /** Subshell ids whose log file was unlinked. */
  removed: string[];
}

/**
 * Delete aged-out pane logs, keeping every running pane's and every file
 * that is not a pane log.
 *
 * Total by construction — housekeeping must never take the daemon down, so
 * every fs failure is logged and swallowed, and an absent dir is a silent
 * no-op (a node that has never logged anything). An id is eligible when the
 * census does not find a LIVE pane for it (terminated, or an orphan whose
 * meta is gone — the file with no record is exactly what a missed delete
 * leaves), its name passes `isSubshellId`, AND `pathAllowed` accepts it
 * against the data dir — the same rule `remove_paths` enforces, which is
 * what refuses a symlink leaf before `unlink` could ever touch anything
 * outside the dir.
 */
export async function sweepExpiredPaneLogs(opts: PaneLogSweepOptions): Promise<PaneLogSweepResult> {
  const removed: string[] = [];
  const { days, hours } = opts.retention;
  // 0 + 0 is the documented keep-forever; a negative can only be a
  // misconfiguration passed around the resolver — neither may be read as
  // "delete everything", so the guard is `<= 0` on the pair.
  if (days <= 0 && hours <= 0) return { removed };

  const dir = join(opts.dataDir, "subshells");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log(`pane log retention: could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { removed };
  }
  const logNames = names.filter((n) => n.endsWith(LOG_SUFFIX));
  if (logNames.length === 0) return { removed }; // nothing to age out — skip even the census

  // The census FIRST for the ids that have records; orphans (no record) fall
  // through it and are eligible, which is the point — that is the transcript
  // a delete the node missed left behind. The id→socket map it also leaves
  // behind is what the per-file re-probe below re-asks: a restart reuses the
  // same log path append-only with the old mtime (pane-runtime's `pane-log.ts`
  // opens `a`), so a pane that comes back inside the census→unlink window
  // would otherwise lose its live transcript mid-write.
  const alive = new Set<string>();
  const sockets = new Map<string, string>();
  const records = await opts.meta.list();
  for (const m of records) sockets.set(m.subshellId, m.socket);
  // The census in waves of {@link CENSUS_CONCURRENCY}. Same probe, same
  // per-record answer, same catch — a serial loop and these chunks agree on
  // every outcome; only the wall-time changed (finding 2).
  for (let i = 0; i < records.length; i += CENSUS_CONCURRENCY) {
    await Promise.all(
      records.slice(i, i + CENSUS_CONCURRENCY).map(async (m) => {
        try {
          if (await opts.tmux.hasSubshell(m.socket, m.subshellId)) alive.add(m.subshellId);
        } catch {
          // tmux not answering is not tmux saying no: count it running.
          alive.add(m.subshellId);
        }
      }),
    );
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - days * DAY_MS - hours * HOUR_MS;
  for (const name of logNames) {
    const id = name.slice(0, -LOG_SUFFIX.length);
    if (!isSubshellId(id)) continue; // only the pane-log name shape — never a stray
    if (alive.has(id)) continue; // running logs are the live replay buffer
    const file = join(dir, name);
    if (!(await pathAllowed(file, [opts.dataDir]))) continue; // symlink / escape refusal, the `remove_paths` rule
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
    } catch (err) {
      // A vanished file is the sweep's job done by someone else; anything
      // else is worth the one line.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`pane log retention: could not stat ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    // Re-probe PER FILE immediately before the unlink — per file rather than
    // one re-census before the loop, so the stale window is the milliseconds
    // between this probe and this unlink, not the whole loop. An id with no
    // record (an orphan) has nothing to re-probe; the census stands. A probe
    // that cannot answer counts as running here exactly as in the census:
    // unknown is not dead.
    if (sockets.has(id)) {
      let aliveNow = true;
      try {
        aliveNow = await opts.tmux.hasSubshell(sockets.get(id)!, id);
      } catch {
        aliveNow = true;
      }
      if (aliveNow) continue;
    }
    try {
      await unlink(file);
      removed.push(id);
    } catch (err) {
      // A file that vanished under us is the sweep's job done by someone
      // else; anything else is worth the one line.
      log(`pane log retention: could not sweep ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed.length > 0) {
    log(`pane log retention: removed ${removed.length} log(s) older than ${days}d ${hours}h`);
  }
  return { removed };
}

/** The config slice a pass resolves against (a full `NodeConfig` satisfies it). */
export type RetentionPassConfig = Pick<NodeConfig, "dataDir" | "logRetentionDays" | "logRetentionHours">;

/** Inputs to {@link createRetentionPass}. */
export interface RetentionPassOptions {
  /** The daemon's boot config: the window to sweep on when a fresh read fails. */
  boot: RetentionPassConfig;
  meta: Pick<SubshellMetaStore, "list">;
  tmux: Pick<TmuxRunner, "hasSubshell">;
  /**
   * Read the CURRENT stored config (production: `loadConfig`). Called every
   * pass, which is what makes a `config.json` write (the dashboard's setter, a
   * hand-edit) land without a restart; the environment layer is constant for
   * the life of the process, so only the stored rung needs re-asking.
   */
  readCurrent: () => Promise<RetentionPassConfig>;
  /** Where a failed fresh read is reported (production: `log`), once per pass. */
  onReadError?: (message: string) => void;
  /** Env for the resolution (production: `process.env`; tests pin every layer without touching it). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The daemon's default hourly pass: resolve the window AGAINST THE CURRENT
 * config, then sweep it.
 *
 * A failed read does NOT skip the pass — it runs on the boot window with one
 * line. Housekeeping that silently stops on a disk hiccup is the failure mode
 * this sweep exists to prevent (an offline node accreting transcripts), and a
 * stale-but-safe window beats no window. The read error is reported rather
 * than swallowed so a machine stuck on its boot window says so in its own log.
 */
export function createRetentionPass(opts: RetentionPassOptions): () => Promise<PaneLogSweepResult> {
  const env = opts.env ?? process.env;
  return async () => {
    let cfg = opts.boot;
    try {
      cfg = await opts.readCurrent();
    } catch (err) {
      opts.onReadError?.(
        `pane log retention: could not re-read the config (${err instanceof Error ? err.message : String(err)}); using the window from boot`,
      );
    }
    const retention = resolveLogRetention(env, cfg);
    return sweepExpiredPaneLogs({ dataDir: cfg.dataDir, retention, meta: opts.meta, tmux: opts.tmux });
  };
}
