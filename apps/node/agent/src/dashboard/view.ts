import { hostname } from "node:os";
import { TmuxRunner } from "@internal/pane-runtime";
import { NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { readAllowedDirs } from "../allowed-dirs.js";
import type { NodeConfig } from "../config.js";
import { mapOs } from "../enroll.js";
import { readMaintenance } from "../maintenance.js";
import { collectRuntime } from "../runtime.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { NODE_VERSION } from "../version.js";
import { getDaemonState } from "./state.js";

/**
 * The local node view — this machine answering `GET /api/nodes/:id` about
 * ITSELF, in the shape `@internal/node-admin`'s cards already render.
 *
 * The field-by-field honesty the shape demands:
 *
 * - `access: "owner"` / `canManage: true` are not claims about a viewer —
 *   there IS no viewer identity on a loopback surface with no login, and the
 *   human on this machine holds the CLI that outranks any web grant. The
 *   fields exist so the cards' gating (hide for non-managers) resolves the
 *   way it always resolves on the machine itself.
 * - `status` is `"online"` in the load-bearing sense: THIS process answers,
 *   so every fact on the page is live-by-construction — which is also why
 *   the restart-wait on a local restart succeeds by RECONNECT rather than by
 *   the socket's `startedAt` changing (the page reloads a different process).
 * - `harnesses` is empty by contract, not by omission: plugins are an
 *   instance concept (inversion spec 2026-09-10 §6) and this page has no
 *   harness card.
 * - `held` is always null — holding is what a PLANE does to a socket, and
 *   the machine cannot be held by itself.
 * - `serverUrl` is the field the plane's view can never carry and this one
 *   always does: the config file is right here.
 */

/** The maintenance mirror read three ways, collapsed to the view's fields. */
function maintenanceFields(dataDir: string): {
  maintenance: boolean;
  maintenanceAt: string | null;
  maintenanceSource: "plane" | "node" | null;
} {
  const read = readMaintenance(dataDir);
  if (read.kind === "absent") return { maintenance: false, maintenanceAt: null, maintenanceSource: null };
  if (read.kind === "state") {
    // The wire carries no source; the file's stamp is shared. "node" is the
    // honest LOCAL answer only when this machine wrote it — which is exactly
    // what either end's write looks like from here, so the dashboard keeps
    // the reconciliation fact rather than inventing a second one: the stamp
    // is shown, the "at the node / from this page" clause is plane-side
    // knowledge (it knows what IT sent), and this surface passes null so the
    // card prints the time and claims no more.
    return { maintenance: read.state.on, maintenanceAt: read.state.changedAt, maintenanceSource: null };
  }
  // Unreadable fails CLOSED: in maintenance, under the file's own mtime.
  return { maintenance: true, maintenanceAt: read.changedAt ?? null, maintenanceSource: null };
}

/**
 * `collectRuntime` spawns the service manager's status query, so the view
 * memoizes it on the SPA's own poll cadence (5 s). The daemon's copy is
 * frozen per process because the `ready` frame must be comparable; this one
 * must survive `service start` — a definition installed while the page is
 * open is news, and a frozen report would sit there denying it.
 */
const RUNTIME_MEMO_MS = 5_000;
let runtimeMemo: { at: number; report: Awaited<ReturnType<typeof collectRuntime>> | null } | null = null;

/** The runtime report, fresh within the memo window. */
export async function liveRuntime(): Promise<Awaited<ReturnType<typeof collectRuntime>> | null> {
  // A restart or install invalidates by TIME, not by event: 5 s of staleness
  // on a card whose page polls at 5 s is invisible, and an event bus for it
  // would be a second daemon contract.
  if (runtimeMemo && Date.now() - runtimeMemo.at < RUNTIME_MEMO_MS) return runtimeMemo.report;
  const report = await collectRuntime().catch(() => null);
  runtimeMemo = { at: Date.now(), report };
  return report;
}

/**
 * The dashboard's `runtime` field. Prefers the daemon's FROZEN report (the
 * `ready` frame's own bytes — so the page shows exactly what the plane is
 * being told) while its `startedAt` still names this process, and falls back
 * to a fresh collect for the no-daemon path (tests, future modes).
 */
async function runtimeForView() {
  return getDaemonState().runtime ?? (await liveRuntime());
}

/** How many subshells are ALIVE on this machine right now (the card's count). */
export async function liveSubshellCount(dataDir: string): Promise<number> {
  const meta = new SubshellMetaStore(dataDir);
  const tmux = new TmuxRunner();
  let alive = 0;
  for (const m of await meta.list()) {
    try {
      if (await tmux.hasSubshell(m.socket, m.subshellId)) alive += 1;
    } catch {
      // A socket that will not answer is not evidence of life — and not of
      // death either; `maintenance on` counts the same way, and the census
      // errs toward "less", because an inflated count would over-promise what
      // the flip stops.
    }
  }
  return alive;
}

/** The whole `GET /api/nodes/:id` body for this machine. */
export async function buildLocalNodeView(cfg: NodeConfig) {
  const runtime = await runtimeForView();
  const m = maintenanceFields(cfg.dataDir);
  // The `ready` frame's capability list, restated for the view so the card
  // shows what the plane is shown.
  const capabilities = ["uploads", "mcp"];
  return {
    id: cfg.nodeId,
    name: cfg.name,
    kind: "agent" as const,
    os: mapOs(process.platform),
    arch: process.arch,
    hostname: hostname(),
    status: "online" as const,
    // "Last seen" is the heartbeat's job on the plane; here the answer is
    // trivially now, and the card renders "just now" — honest, since this
    // page is the machine answering.
    lastSeenAt: new Date().toISOString(),
    agentVersion: NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    access: "owner" as const,
    canManage: true,
    // The local mirror decides launches fail-closed, same as the gate does:
    // unreadable maintenance state means this machine launches nothing.
    canLaunch: !m.maintenance,
    allowedDirs: readAllowedDirs(cfg.dataDir),
    capabilities,
    harnesses: [],
    inventoryStale: false,
    maintenance: m.maintenance,
    maintenanceAt: m.maintenanceAt,
    maintenanceSource: m.maintenanceSource,
    held: null,
    serverUrl: cfg.serverUrl,
    runtime,
    runningSubshells: await liveSubshellCount(cfg.dataDir),
  };
}
