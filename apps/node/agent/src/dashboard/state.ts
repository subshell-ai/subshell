import type { NodeRuntimeReport } from "@internal/subshell-protocol";

/**
 * The live facts the daemon knows that the dashboard serves cannot be read
 * off disk: whether the plane socket is UP right now, when the last heartbeat
 * ticked, and how this process runs. This module is the one place they are
 * handed across the (process-internal) boundary from `daemon.ts` to
 * `server.ts`.
 *
 * It is deliberately a module-level singleton rather than a parameter, for
 * the same reason `log.ts` is one: the daemon's call sites live deep inside
 * the connect loop, and threading a state object through `runDaemon` would
 * change the daemon's signature (and every one of its tests) to serve a
 * second surface. The state is process-wide fact — there is exactly one
 * daemon and one dashboard per process — so a singleton is the truth, not a
 * shortcut. Tests import, set, and read it; nothing persists.
 *
 * `restart` arrives the same way and for a sharper reason: the ONLY safe way
 * to restart this process is the daemon's own path (result-frame discipline,
 * clean socket close, lock removal), which lives inside `runDaemon`'s
 * closure as `ctx.requestRestart`. The dashboard asks; the daemon acts.
 */

/** What the daemon publishes; every field starts null because the daemon
 *  may not have connected yet — or may never (a plane that is down is a
 *  dashboard still worth opening). */
export interface DaemonLiveState {
  /** The control-plane base URL this node dials (from the loaded config). */
  serverUrl: string | null;
  /** The node's id (from the loaded config) — the dashboard's `:id` for /api/self. */
  nodeId: string | null;
  /** Whether the /ws/node socket is up right now. */
  connected: boolean;
  /** ISO stamp of the last heartbeat tick, or null while never connected. */
  lastHeartbeatAt: string | null;
  /** How this process runs (the same report `ready` carries), or null. */
  runtime: NodeRuntimeReport | null;
}

const state: DaemonLiveState = {
  serverUrl: null,
  nodeId: null,
  connected: false,
  lastHeartbeatAt: null,
  runtime: null,
};

/** Merge one update from the daemon. `undefined` fields are left alone. */
export function setDaemonState(patch: Partial<DaemonLiveState>): void {
  Object.assign(state, patch);
}

/** A snapshot for the routes (copied: the caller must not keep the live object). */
export function getDaemonState(): DaemonLiveState {
  return { ...state };
}

let restartFn: (() => void) | null = null;

/** The daemon registers its `ctx.requestRestart` at context-build time. */
export function registerRestart(fn: (() => void) | null): void {
  restartFn = fn;
}

/**
 * Ask the daemon to exit for the service manager to respawn — the daemon's
 * own path, with its result-frame discipline. Returns false when no daemon
 * is running in this process (`subshell dashboard` over a dead config, a
 * test harness), so the caller can say "restart it where it was started"
 * rather than pretend.
 */
export function requestDaemonRestart(): boolean {
  if (restartFn === null) return false;
  restartFn();
  return true;
}
