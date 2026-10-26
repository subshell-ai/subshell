import { semverLt } from "@internal/subshell-protocol";

/**
 * The in-memory tracker of node updates this server ordered (design
 * 2026-09-25): the honest in-flight progress the Updates page renders, and
 * the reason it exists is a page REFRESH. Until now that state lived only in
 * the React component, so reloading mid-update lost the story — the row went
 * back to a bare version pair while the machine was minutes into a download.
 * The server already witnesses every transition that matters (the dispatch,
 * the refusal, the `ready` that confirms a boot), so the tracker stores those
 * moments and nothing else: no sweeper, no persistence, no timers. The map is
 * bounded by the number of distinct node ids this process has been asked to
 * update (one entry each, replaced on re-press); nothing accumulates without
 * an order, which is why no sweeper is needed.
 *
 * **Terminal phases are derived at read time, never stored.** `done` and
 * `failed` are an entry that has been stamped `endedAt` (with or without a
 * note), and `stalled` is purely `nowMs - startedAt >= STALL_MS` on an
 * unstamped entry. That is what lets a `stalled` row still resolve to `done`
 * when the slow node finally reports — the state most likely to be real and
 * most likely to be rendered wrong.
 *
 * **In-memory means a server restart forgets it, and that is accepted.** The
 * node entries survive their subject (the update happens on the machine, the
 * plane's process keeps running); only the SELF entry crosses a process
 * boundary, and the boot finalizer re-creates it from the on-disk marker
 * (`update-transaction.ts` calls {@link resolveSelfUpdate}) — see its comment.
 *
 * Pure module: no IO at import (the import-purity test covers the whole entry
 * graph), no timers, and every stamp goes through {@link updateTrackerSeams}.
 */

/**
 * When a non-terminal entry stops reading as "in flight" and starts reading
 * as "nobody has confirmed anything in this long". Two minutes, the figure the
 * page's own watcher used before the tracker made the verdict server state —
 * the same belief the operator already had, now said out loud so it survives a
 * refresh.
 */
export const STALL_MS = 120_000;

/**
 * How long a terminal entry stays readable after it ended. Ten minutes, the
 * `HELD_IDLE_MS` shape: long enough for the operator to come back from
 * wherever they walked to and still see what happened, short enough that the
 * map cannot accumulate yesterday's fleet. Stalled entries expire ten minutes
 * past the moment THEY stalled, since that is their "end" for this purpose.
 */
export const TERMINAL_EXPIRE_MS = 10 * 60 * 1000;

/** The map key of the server's own entry. Node ids are uuids, so nothing can collide. */
const SELF_KEY = "server";

/** What a stored entry is while still live. Terminal states are derived, so `done`/`failed`/`stalled` are NOT here. */
type StoredPhase = "working" | "restarting";

/**
 * The phase a reader sees: the two stored ones, the two terminal ones derived
 * from the stamps, and `stalled` derived from the clock.
 */
export type UpdatePhase = StoredPhase | "done" | "failed" | "stalled";

/** One entry as {@link readView} renders it. Times are epoch ms; the route serializes ISO. */
export interface UpdateStateView {
  /** The version the plane saw there when the order went out (`"unknown"` until the node first reported one). */
  from: string;
  /** The version the plane ordered. */
  to: string;
  /** Epoch ms of the begin — the stall clock's zero. */
  startedAt: number;
  /** The derived phase (see {@link UpdatePhase}). */
  phase: UpdatePhase;
  /** The failing sentence, for a `failed` entry; null for every other phase. */
  message: string | null;
  /** Epoch ms for a `done`/`failed` entry; null for anything still live — including `stalled`, which a later `ready` can still resolve. */
  endedAt: number | null;
}

/** Everything the tracker knows, as the route consumes it. */
export interface UpdateSnapshot {
  /** In-flight-or-recent node updates, keyed by node id. */
  nodes: Record<string, UpdateStateView>;
  /** This server's own update, re-created at boot; null when this process has no such story. */
  server: UpdateStateView | null;
}

interface Entry {
  from: string;
  to: string;
  startedAt: number;
  /** Live phase only; see the module comment for why terminal is never stored. */
  phase: StoredPhase;
  /** Set ⇒ `failed`, with this as the sentence. The presence IS the terminality. */
  failedNote?: string;
  /** Set (with or without a note) ⇒ terminal; `failedNote === undefined` here reads as `done`. */
  endedAt?: number;
}

const entries = new Map<string, Entry>();

/**
 * The clock seam (the repo's `Seams` idiom): every stamp and the default
 * `readView` time come through it, so the stall and expiry boundaries are
 * testable at the exact millisecond. @internal
 */
export const updateTrackerSeams = {
  now: (): number => Date.now(),
};

/** Terminal in the stored sense — `stalled` is derived and deliberately NOT terminal. */
function isTerminal(entry: Entry): boolean {
  return entry.endedAt !== undefined;
}

/**
 * Order an update against `nodeId`.
 *
 * REPLACES any prior entry for the node, terminal or not: a second press is a
 * second act, and its clock starts now. The route calls this only after every
 * 409 gate has passed — a refused offer never opens an entry, because the
 * plane never ordered anything in that case.
 */
export function beginUpdate(nodeId: string, facts: { from: string; to: string }): void {
  entries.set(nodeId, { from: facts.from, to: facts.to, startedAt: updateTrackerSeams.now(), phase: "working" });
}

/**
 * The swap succeeded — the node answered the `update` command before it exits
 * to restart into the new binary. Moves `working` → `restarting` and stamps
 * nothing else: the stall clock keeps running from the order, because the
 * honest reading of "downloaded, installing, back in 10 seconds" that never
 * comes back is exactly as stalled as a download that never ended.
 * A no-op without a live entry (a late answer after some other seam ended it).
 */
export function updateSwapped(nodeId: string): void {
  const entry = entries.get(nodeId);
  if (!entry || isTerminal(entry)) return;
  entry.phase = "restarting";
}

/**
 * The node REFUSED and did nothing — terminal `failed` carrying the sentence
 * the route answered with, so the row says what the error toast said and keeps
 * saying it after a refresh.
 */
export function updateRefused(nodeId: string, message: string): void {
  const entry = entries.get(nodeId);
  if (!entry || isTerminal(entry)) return;
  entry.failedNote = message;
  entry.endedAt = updateTrackerSeams.now();
}

/**
 * The command timed out: the ONE failure that may not be one (the dispatch's
 * comment at `update-node.route.ts` carries the argument — a slow link means
 * this node installs, restarts, and comes back on the new version while the
 * request 409'd). The entry therefore stays `working` untouched, deliberately:
 * the stall clock must run, and the `ready` that eventually lands must still
 * resolve it. This function exists so the moment is a named seam rather than
 * an absent call — its no-op body is the tested posture.
 */
export function updateOutcomeUnknown(nodeId: string): void {
  // Deliberately nothing. See the doc comment; `update-tracker.test.ts` pins
  // working-after-unknown and a late ready resolving it.
  void nodeId;
}

/**
 * A `ready` landed from `nodeId` reporting `agentVersion` — the plane's only
 * evidence of what actually runs there now. If a non-terminal entry is open
 * (including a stalled one):
 *
 * - version NOT older than `to` (equal by the route's own comparator, or
 *   newer — a hand-update that overtook the order): `done`.
 * - version older than `to` WHEN THIS PLANE WITNESSED THE SWAP (`restarting`):
 *   `failed`, noting the rollback — the boot that could not migrate put the
 *   old binary back (docs/updating.md).
 * - version older than `to` while still `working`: NOTHING. The agent re-dials
 *   on its own, so a socket flap during the download (or a `ready` queued
 *   around the order) reports the STILL-RUNNING old version. Terminalizing
 *   there would discard the honest `ready` minutes later; the entry waits,
 *   and the stall clock and expiry answer if none comes.
 * - a version that does not read as a version (the frame validator guarantees
 *   only isStr, and the ws handler itself falls back to `"unversioned"`):
 *   ignored. Garbage must not compare its way into a permanent verdict; the
 *   entry waits for a report it can actually read.
 *
 * A terminal or absent entry records nothing — the story already has an end.
 */
export function recordNodeReady(nodeId: string, agentVersion: string): void {
  const entry = entries.get(nodeId);
  if (!entry || isTerminal(entry)) return;
  if (!VERSION_SHAPE.test(agentVersion)) return;
  if (semverLt(agentVersion, entry.to)) {
    if (entry.phase !== "restarting") return;
    entry.failedNote = `rolled back to ${agentVersion}`;
  }
  entry.endedAt = updateTrackerSeams.now();
}

/** What counts as a readable version: a `MAJOR.MINOR.PATCH` prefix (build suffix allowed). */
const VERSION_SHAPE = /^\d+\.\d+\.\d+/;

/**
 * `nodeId`'s authenticated socket dropped. Deliberately NOTHING observable:
 * a mid-update disconnect is exactly as likely a network flap as the node
 * restarting into its new binary, and inferring `restarting` from it would
 * claim the swap happened on every flap. The stall clock and the next `ready`
 * remain the only arbiters. The seam exists — and stays a no-op — because the
 * temptation to infer is the point; the test pins it.
 */
export function recordNodeDisconnect(nodeId: string): void {
  void nodeId;
}

/** Begin this server's own update (the swap-time half; see {@link resolveSelfUpdate} for the boot half). */
export function beginSelfUpdate(facts: { from: string; to: string }): void {
  beginUpdate(SELF_KEY, facts);
}

/**
 * End this server's own entry: the boot finalizer's write, beside the
 * completion audit and beside the two failure recorders in
 * `update-transaction.ts`.
 *
 * **The asymmetry, stated honestly**: the {@link beginSelfUpdate} entry cannot
 * survive the restart — it lives in the process that exits for the manager.
 * So the boot that completes or fails the transaction RE-CREATES the terminal
 * entry from the on-disk marker (`recreateFrom`, the fields of `PendingUpdate`),
 * and a page loaded after recovery tells the true story with a fresh entry
 * whose begin call was never seen. A `recreateFrom` with no prior entry is
 * exactly the normal post-restart case; an entry plus no `recreateFrom` is a
 * same-process end (tests, or a begin whose boot somehow never swapped).
 * With neither, nothing is recorded — a resolve for a story nobody told.
 */
export function resolveSelfUpdate(
  outcome: "done" | "failed",
  detail?: string | null,
  recreateFrom?: { from: string; to: string; startedAt?: string },
): void {
  let entry = entries.get(SELF_KEY);
  if (!entry) {
    if (!recreateFrom) return;
    const parsed = recreateFrom.startedAt === undefined ? Number.NaN : Date.parse(recreateFrom.startedAt);
    entry = {
      from: recreateFrom.from,
      to: recreateFrom.to,
      startedAt: Number.isNaN(parsed) ? updateTrackerSeams.now() : parsed,
      phase: "working",
    };
    entries.set(SELF_KEY, entry);
  }
  if (isTerminal(entry)) return;
  if (outcome === "failed") entry.failedNote = detail ?? "the update failed";
  entry.endedAt = updateTrackerSeams.now();
}

/** Derive the readable phase from the stored stamps plus the clock. */
function derive(entry: Entry, nowMs: number): UpdatePhase {
  if (entry.failedNote !== undefined) return "failed";
  if (entry.endedAt !== undefined) return "done";
  if (nowMs - entry.startedAt >= STALL_MS) return "stalled";
  return entry.phase;
}

/** Whether the entry is still renderable: terminal entries expire, stalled ones expire from when THEY stalled. */
function alive(entry: Entry, nowMs: number): boolean {
  if (entry.endedAt !== undefined) return nowMs < entry.endedAt + TERMINAL_EXPIRE_MS;
  if (nowMs - entry.startedAt >= STALL_MS) return nowMs < entry.startedAt + STALL_MS + TERMINAL_EXPIRE_MS;
  return true;
}

function view(entry: Entry, nowMs: number): UpdateStateView {
  return {
    from: entry.from,
    to: entry.to,
    startedAt: entry.startedAt,
    phase: derive(entry, nowMs),
    message: entry.failedNote ?? null,
    endedAt: entry.endedAt ?? null,
  };
}

/**
 * Everything renderable right now. Expired entries are FILTERED here rather
 * than deleted on a timer — the map is bounded by the fleet's activity, the
 * module holds no clock, and the test suite can read any boundary millisecond
 * because nothing ever fired between reads.
 *
 * @param nowMs - the clock to derive against; defaults to the seams clock
 */
export function readView(nowMs: number = updateTrackerSeams.now()): UpdateSnapshot {
  const snapshot: UpdateSnapshot = { nodes: {}, server: null };
  for (const [key, entry] of entries) {
    if (!alive(entry, nowMs)) continue;
    if (key === SELF_KEY) snapshot.server = view(entry, nowMs);
    else snapshot.nodes[key] = view(entry, nowMs);
  }
  return snapshot;
}

/** Empties the tracker. Test seam only; @internal. */
export function resetForTests(): void {
  entries.clear();
}
