import type { UpdatesView, UpdateTrackerState } from "@/types/updates";

/** What {@link useUpdates} polls at while the server says something is moving. */
const ACTIVE_POLL_MS = 2_000;

/**
 * Live for the poller's purposes: the machine is mid-download, mid-swap or
 * mid-restart and the answer will change without anyone touching the page.
 *
 * `stalled` deliberately reads as OVER, not live. It is not terminal on the
 * server (a late `ready` still resolves it to `done`), but as a poll gate it
 * marks the point where continuing to ask is pretending to know: the page
 * says its hedge and a human takes over. The eventual resolution surfaces
 * on the next natural read.
 */
function isLive(update: UpdateTrackerState | null | undefined): boolean {
  // Loose on purpose: a cached or hand-stubbed payload can carry the field
  // as UNDEFINED, and throwing here fails inside the query scheduler rather
  // than at the readable "no tracker" answer.
  return update != null && (update.phase === "working" || update.phase === "restarting");
}

/**
 * The refetch cadence for the Updates query.
 *
 * The page's standing rule is no background poll (`useUpdates`' comment
 * carries it); what the server-side tracker added is a SERVER-decided answer
 * to "is anything moving", which is what makes refresh-resume and
 * other-tab-visible progress possible without the component owning clocks.
 * The job gate below is the same server-decided rule for the pre-swap window,
 * before the self tracker entry exists at all. An explicit cadence (a server
 * job this tab started, watched at 1 s) still outranks it.
 */
export function updatesPollMs(view: UpdatesView | undefined, explicitMs: number | false): number | false {
  if (explicitMs !== false) return explicitMs;
  if (view === undefined) return false;
  // A live SERVER JOB is a "something is moving" the tracker cannot say: the
  // self entry is opened at the swap (server-update.ts), so for the whole
  // download-verify-backup stretch the job is the only fact. Reading it here
  // is what lets a page REFRESHED mid-download keep counting MB instead of
  // rendering a frozen line; when the server exits for its restart, this
  // same gate keeps the query refetching into the outage until the new boot
  // answers with the terminal tracker entry. (Operator report 2026-09-30:
  // "why do I lose current update status when I refresh the page".)
  if (view.server.job !== null && view.server.job.phase !== "failed") return ACTIVE_POLL_MS;
  if (isLive(view.serverUpdate)) return ACTIVE_POLL_MS;
  return (view.nodes?.rows ?? []).some((row) => isLive(row.update)) ? ACTIVE_POLL_MS : false;
}
