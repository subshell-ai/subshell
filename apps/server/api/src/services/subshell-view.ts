import type { Access } from "@/lib/subshell-access.js";

/** Rough liveness state of a subshell, derived from output recency. */
export type Activity = "active" | "idle" | "terminated";

/**
 * Rough activity: running + output within 60s = active, else idle.
 *
 * Known limitation (plan property, accepted): a subshell that is working but
 * quiet for >60s (e.g. an agent "thinking") shows as idle. A future round
 * could add a progress-aware signal (harness heartbeat or an adaptive
 * window) to avoid false-idle for slow-but-working agents.
 */
export function computeActivity(lastOutputAt: string | null, status: string, now = Date.now()): Activity {
  if (status !== "running") return "terminated";
  if (!lastOutputAt) return "active"; // just started
  return now - new Date(lastOutputAt).getTime() <= 60_000 ? "active" : "idle";
}

/**
 * The pure row-to-view mapping behind every subshell the API returns,
 * extracted from `subshell-manager.service.ts` (spec 2026-09-28 §4) with the
 * behavior unchanged. It performs NO I/O: every fact it consults arrives as a
 * parameter. The caller captures the preview, computes the node-offline
 * verdict, and passes the node's current harness-version snapshot map, so the
 * mapping stays referentially transparent and testable in isolation. The
 * manager keeps the stamping and snapshot machinery because those need its
 * dependencies; this module needs none.
 */
export function toSubshellView(
  row: {
    id: string;
    userId: string;
    presetId: string | null;
    harnessId: string;
    nodeId: string;
    name: string;
    workingDir: string;
    status: string;
    createdAt: string;
    endedAt: string | null;
    lastOutputAt: string | null;
    alive: number;
    exitCode: number | null;
    startedAt: string | null;
    backoffCount: number;
    restartOnExit: number;
    nextRestartAt: string | null;
    nameLocked: number;
    notify: number;
    waitingSince: string | null;
    lastPushUrgency: number | null;
    crossAgent: number;
    /**
     * The harness CLI version this pane's current process started on (Task 5's
     * column; optional so pre-column row literals and legacy callers stay
     * valid and read `null`).
     */
    harnessVersion?: string | null;
  },
  status: string,
  /** The subshell's current screen, bottom-first-trimmed; empty when not running. */
  preview: string[] = [],
  /**
   * Viewer-relative access to attach to the view. A returned row is always
   * visible to *someone*, so this is never `"none"`. Defaults to `"owner"` so
   * the many owner-keyed direct callers stay valid; the sharing service
   * overrides it per-viewer.
   */
  access: Exclude<Access, "none"> = "owner",
  /**
   * The row's agent node has no live connection (spec §5.6) — the subshell
   * may still be running there. Computed by the caller via
   * {@link isNodeOffline}; local rows (and every legacy caller) pass nothing
   * and read false.
   */
  nodeOffline = false,
  /**
   * The node's CURRENT harness versions (harnessId to version), from its
   * inventory snapshot. Absent map = nothing known, which is every unknown
   * reading this function returns: never a stale claim, only ever a fact.
   */
  nodeHarnessVersions?: ReadonlyMap<string, string>,
) {
  const harnessCurrentVersion = nodeHarnessVersions?.get(row.harnessId) ?? null;
  return {
    id: row.id,
    presetId: row.presetId,
    harnessId: row.harnessId,
    // issue #250: the version this pane's process started on, the version the
    // node now reports, and the ONE derived comparison between them. Clients
    // render; none of them decides. Two nulls are an absence, not a
    // disagreement, so an unprobed pair never raises the flag.
    harnessVersion: row.harnessVersion ?? null,
    harnessCurrentVersion,
    harnessStale:
      row.harnessVersion != null && harnessCurrentVersion != null && row.harnessVersion !== harnessCurrentVersion,
    nodeId: row.nodeId,
    name: row.name,
    workingDir: row.workingDir,
    status,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    lastOutputAt: row.lastOutputAt,
    activity: computeActivity(row.lastOutputAt, status),
    // The manager is OWNER-KEYED and knows nothing about grants, so it reports
    // the private shape. `subshells.service.ts` — the sharing-aware layer that
    // already loads the grant map to resolve `access` — overrides both.
    shareCount: 0,
    sharedWithEveryone: false,
    // The subshell's current screen, captured by the caller (see
    // SubshellManagerService#preview). Passed in rather than read here so this
    // stays a pure mapping and the tmux call has one home.
    preview,
    alive: row.alive === 1,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    backoffCount: row.backoffCount,
    restartOnExit: row.restartOnExit === 1,
    nextRestartAt: row.nextRestartAt,
    nameLocked: row.nameLocked === 1,
    notify: row.notify === 1,
    // How this pane was OPENED: an agent over MCP, not a human at the UI. The
    // rail files these under "Cross-agent comms" and their bell defaults off.
    crossAgent: row.crossAgent === 1,
    // ISO ts of the attention event that put this subshell in waiting-for-you
    // state (null = not waiting); cleared by the watcher on output-resume/death.
    waitingSince: row.waitingSince,
    // "A delivered push the owner has not answered by opening the pane"
    // (spec 2026-09-23) — what turns the rail's dot into a bell.
    unseenPush: row.lastPushUrgency !== null,
    access,
    // Agent node unreachable right now (see the param doc) — the UI's
    // "node offline" chip; false for every local subshell.
    nodeOffline,
  };
}
