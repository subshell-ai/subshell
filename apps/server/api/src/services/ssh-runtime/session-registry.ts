import { logger } from "@/utils/logger.js";
import { matchCallbackPath } from "./callback-allowlist.js";
import { executeCallbackAsPane } from "./callback-executor.js";
import type { SessionEventHooks, SshRuntimeSession } from "./session.js";

/**
 * The live session registry (design 2026-10-05 §4): three maps and the
 * routing functions the node-event handler calls. This is the only place a
 * `session_frame` can land, the only place a runtime node id resolves to a
 * session, and the only thing that knows "is this session open RIGHT NOW"
 * (the DB row records history; the registry is authority for liveness).
 *
 * Containment, per the design's frame-routing rule: a `session_frame` naming
 * another node's ref, or a ref with no registered session, is DROPPED at the
 * identity check below - never forwarded anywhere, never an error the node
 * has to police. The node side enforces its own copy (one SSH child per
 * ref, per its data dir); this is the plane's copy, and both are structural.
 */

const sessionsById = new Map<string, SshRuntimeSession>();
const sessionIdsByRuntimeNode = new Map<string, string>();

/** Register a session the service just opened (wires the event hooks in place). */
export function registerSession(session: SshRuntimeSession): void {
  sessionsById.set(session.id, session);
  sessionIdsByRuntimeNode.set(session.runtimeNodeId, session.id);
}

/** Drop a settled session (close/lost finalization; the row keeps the history). */
export function unregisterSession(session: SshRuntimeSession): void {
  sessionsById.delete(session.id);
  if (sessionIdsByRuntimeNode.get(session.runtimeNodeId) === session.id) {
    sessionIdsByRuntimeNode.delete(session.runtimeNodeId);
  }
}

export function getSession(id: string): SshRuntimeSession | undefined {
  return sessionsById.get(id);
}

/**
 * The launcher-registry branch: the live session behind a `runtime` node id.
 * undefined means no live session (a lost/closed row, or a restarted plane),
 * and the caller falls back to the offline-rejecting `RemoteLauncher` - which
 * is the honest reading of "the pane's machine is gone".
 */
export function liveSessionForRuntimeNode(runtimeNodeId: string): SshRuntimeSession | undefined {
  const id = sessionIdsByRuntimeNode.get(runtimeNodeId);
  if (id === undefined) return undefined;
  const session = sessionsById.get(id);
  return session !== undefined && session.status === "active" ? session : undefined;
}

/**
 * Route one pumped `session_frame`. Returns false for a frame the registry
 * drops (wrong node, unknown ref, dead channel) so the caller can log it.
 */
export function deliverSessionFrame(nodeId: string, ref: string, dataB64: string): boolean {
  const session = sessionsById.get(ref);
  if (session === undefined || session.connectingNodeId !== nodeId) return false;
  let bytes: Uint8Array;
  try {
    const buf = Buffer.from(dataB64, "base64");
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return false; // BASE64_RE already vetted the string at the parse; belt for non-Node bases
  }
  session.ingestBytes(bytes);
  return true;
}

/** The node's `ssh_session_lost` error event: the child died; the session ends. */
export function deliverSessionLost(nodeId: string, ref: string): void {
  const session = sessionsById.get(ref);
  if (session === undefined || session.connectingNodeId !== nodeId) return;
  session.markLost("child-lost");
}

/**
 * The connecting node's link closed: every session it brokered is over
 * (design §6 Disconnect - the SSH child rode that socket's daemon). Called
 * from the node-close path; panes keep `status: running` with `alive: 0`.
 */
export function markSessionsLostForNode(connectingNodeId: string): void {
  for (const session of sessionsById.values()) {
    if (session.connectingNodeId === connectingNodeId) session.markLost("node-disconnected");
  }
}

/** Every live session's id (the shutdown path's sweep; @internal for tests too). */
export function allLiveSessionIds(): string[] {
  return [...sessionsById.keys()];
}

/** Drop every registration (test isolation; production never calls it). @internal */
export function resetSessionRegistryForTests(): void {
  sessionsById.clear();
  sessionIdsByRuntimeNode.clear();
}

/* ------------------------------------------------------------------ */
/* the shared hook wiring (one object for every session; see session.ts) */
/* ------------------------------------------------------------------ */

/**
 * Build the hook object a session is registered with. The settling behavior
 * (row settle, node offline, pane `alive` flips, token revocation) lives in
 * `session-settle.ts`; the four settle callbacks here forward to the injected
 * settler, which `installSessionSettlers` installs once at service-module
 * load. The injection keeps the cycle (service -> registry -> settle ->
 * registry) out of the module graph. The two callback-surface hooks
 * (`resolveCallbackPane`, `executeCallback`) are wired here directly: they
 * are read-side policy and execution, not settle writes.
 */
type SessionSettler = Pick<SessionEventHooks, "onLost" | "onClosed" | "onPaneExit" | "onReport">;

let settler: SessionSettler | undefined;

/** Install the settle handlers from `session-settle.ts` (called once from the service module's load, before any session exists). */
export function setSessionSettlers(impl: SessionSettler): void {
  settler = impl;
}

/** The hooks every registered session shares. */
export function sessionHooks(): SessionEventHooks {
  return {
    onLost: (s, reason) => {
      logger.debug(`ssh-runtime session ${s.id.slice(0, 8)} lost (${reason})`);
      settler?.onLost(s, reason);
    },
    onClosed: (s) => settler?.onClosed(s),
    onPaneExit: (s, id, code, at) => settler?.onPaneExit(s, id, code, at),
    onReport: (s, rows) => settler?.onReport(s, rows),
    resolveCallbackPane: (s, path, method) => {
      // A session with exactly one pane has an unambiguous owner; multiple
      // panes make the frame's path itself the selector, and the matcher
      // refuses any id that is not this session's pane (design §5's
      // substitution rule). The slice's callback surface is one pane per
      // session; multi-pane resolution is workstream C's (recorded).
      if (s.paneIds().length !== 1) return null;
      const paneId = s.paneIds()[0] as string;
      const decision = matchCallbackPath(path, method, paneId);
      return decision.allow ? decision.paneId : null;
    },
    executeCallback: (s, reqId, paneId, method, path, body) =>
      executeCallbackAsPane(s, reqId, paneId, method, path, body),
  };
}
