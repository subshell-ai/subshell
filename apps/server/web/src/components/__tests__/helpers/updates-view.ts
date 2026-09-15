import type { StartServerUpdate } from "@/hooks/use-updates";
import type { NodeUpdateRow, NodeUpdates, ServerUpdateView, UpdatesView } from "@/types/updates";

/**
 * A complete `GET /api/admin/updates` body, for the Updates page's cards.
 *
 * Shared by every card test rather than re-typed in each: the view is large
 * and mostly irrelevant to any one card, so a per-file copy would be three
 * copies drifting away from the route's schema at three different rates —
 * the reason `deployment-view.ts` exists beside it.
 */

/** The server card's half, at the ordinary "an update is available" state. */
export function serverUpdateView(over: Partial<ServerUpdateView> = {}): ServerUpdateView {
  return {
    source: { url: "https://api.github.com/repos/subshell-ai/subshell/releases?per_page=100", enabled: true },
    current: "0.6.0",
    latest: { version: "0.7.0", tag: "server-v0.7.0", publishedAt: "2026-09-15T10:00:00.000Z" },
    latestError: null,
    updateAvailable: true,
    canApply: { ok: true, reasons: [] },
    binary: { kind: "compiled", path: "/home/u/.local/bin/subshell-server", reason: null },
    paneSafety: "keeps",
    job: null,
    lastFailure: null,
    backups: { dir: "/c/backups", keep: 5, count: 2, latest: null },
    ...over,
  };
}

/** The fleet, empty by default — a row is added by the case that needs one. */
export function nodeUpdates(over: Partial<NodeUpdates> = {}): NodeUpdates {
  return {
    release: { version: "0.9.0", tag: "node-v0.9.0", publishedAt: null },
    reason: null,
    minAgentVersion: "0.7.0",
    protocol: 10,
    rows: [],
    ...over,
  };
}

/** One enrolled agent, online and up to date unless told otherwise. */
export function nodeRow(over: Partial<NodeUpdateRow> = {}): NodeUpdateRow {
  return {
    id: "n1",
    name: "workhorse",
    agentVersion: "0.9.0",
    target: "linux-x64",
    protocolVersion: 10,
    online: true,
    held: null,
    updateAvailable: false,
    canUpdate: { ok: false, reason: "this node is offline" },
    ...over,
  };
}

/** The whole page's read. */
export function updatesView(over: Partial<UpdatesView> = {}): UpdatesView {
  return {
    server: serverUpdateView(),
    nodes: nodeUpdates(),
    desktop: {
      server: { version: "0.7.0", tag: "desktop-server-v0.7.0", publishedAt: null },
      client: { version: "0.5.0", tag: "desktop-client-v0.5.0", publishedAt: null },
    },
    ...over,
  };
}

/** An update handle that is idle and records nothing — for cards that only render it. */
export const idleUpdate: StartServerUpdate = {
  outcome: "idle",
  error: null,
  installing: null,
  start: async () => {},
};

/** An update handle that records the presses it was given. */
export function recordingUpdate(over: Partial<StartServerUpdate> = {}): StartServerUpdate & {
  pressed: { force?: boolean }[];
} {
  const pressed: { force?: boolean }[] = [];
  return {
    ...idleUpdate,
    pressed,
    start: async (opts) => {
      pressed.push(opts);
    },
    ...over,
  };
}
