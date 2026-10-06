import type { NodeConnection } from "@/services/nodes/node-registry.js";
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
/**
 * Which node-link CONNECTION brokered which live session (round-3 review
 * MAJOR). The tag is the registry's own connection bookkeeping, kept here
 * rather than on the session so the byte-channel class stays free of node-ws
 * facts: a session without a tag never survives a sweep (only test fixtures
 * register untagged; every production open passes the live record).
 */
const brokeredConnections = new Map<string, NodeConnection>();

/**
 * Register a session the service just opened (wires the event hooks in
 * place). `brokeredOn` is the node's live connection the open RPC rode -
 * the identity the ready-time sweep compares against to tell "rode the
 * prior link" from "belongs to this one".
 */
export function registerSession(session: SshRuntimeSession, brokeredOn?: NodeConnection): void {
  sessionsById.set(session.id, session);
  sessionIdsByRuntimeNode.set(session.runtimeNodeId, session.id);
  if (brokeredOn !== undefined) brokeredConnections.set(session.id, brokeredOn);
}

/** Drop a settled session (close/lost finalization; the row keeps the history). */
export function unregisterSession(session: SshRuntimeSession): void {
  sessionsById.delete(session.id);
  brokeredConnections.delete(session.id);
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

/**
 * The replacement link came up (`ready`): every session this node carries
 * that was NOT brokered on `current` rode the prior link, and that link's
 * death killed its children on the agent side (the daemon's drain, review
 * M1) - the plane must say `lost` too, in every close ordering. The superseded
 * close arm cannot say it (it must not touch the newer connection's business)
 * and a black-hole flap never runs it at all, so this is its convergence
 * point; the branch-1 close arm keeps marking all sessions directly, as the
 * faster path when the FIN does arrive.
 *
 * The tag decides "before this connection" by IDENTITY, not by clock: a
 * session brokered on `current` (an open whose RPC rode the new socket before
 * its own `ready`) survives the sweep, and re-running it on a repeated
 * `ready` costs an already-lost session nothing.
 */
export function markSessionsLostBeforeConnection(connectingNodeId: string, current: NodeConnection): void {
  for (const session of sessionsById.values()) {
    if (session.connectingNodeId !== connectingNodeId) continue;
    if (brokeredConnections.get(session.id) === current) continue;
    session.markLost("node-disconnected");
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
  brokeredConnections.clear();
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
    resolveCallbackPane: (s, path, method, framePaneId) => {
      // The door rule (task 25). A frame ATTRIBUTED by the runtime's pane door
      // is honored only for a pane this session really issued: the id must
      // name a live pane token (a forged or stale attribution is a 403 like
      // any other), and the matcher still forces the PATH's id to equal the
      // executing pane (design §5's substitution rule). The attribution came
      // from the door the connection arrived on - no credential crossed the
      // wire to produce it - but the plane's membership check is what makes a
      // lying runtime no stronger than the pane whose door it used.
      if (framePaneId !== undefined) {
        if (s.paneToken(framePaneId) === undefined) return null;
        const decision = matchCallbackPath(path, method, framePaneId);
        return decision.allow ? decision.paneId : null;
      }
      // No attribution = the SHARED door (the slice's manual-curl surface). Its
      // rule is unchanged: a session with exactly one pane has an unambiguous
      // owner; a multi-pane session cannot resolve an unattributed request,
      // because choosing among panes by the path's self-declared id is
      // precisely the authority this rule refuses to grant a typed path.
      if (s.paneIds().length !== 1) return null;
      const paneId = s.paneIds()[0] as string;
      const decision = matchCallbackPath(path, method, paneId);
      return decision.allow ? decision.paneId : null;
    },
    executeCallback: (s, reqId, paneId, method, path, body) =>
      executeCallbackAsPane(s, reqId, paneId, method, path, body),
  };
}
