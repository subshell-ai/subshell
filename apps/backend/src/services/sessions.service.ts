import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import type { GuardActor } from "@/api/auth-guard.js";
import { HttpError } from "@/api/auth-guard.js";
import { harnessUsable } from "@/api/harness-utils.js";
import type { ShareEntry } from "@/db/repositories/session-shares.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SessionSharePermission } from "@/db/types/session-shares.db-types.js";
import type { SessionTable } from "@/db/types/sessions.db-types.js";
import { loadNodeAccess, type NodeAccessDeps, nodeCanLaunch } from "@/lib/node-access.js";
import { type Access, accessAtLeast, loadSessionAccess, resolveSessionAccess } from "@/lib/session-access.js";
import { BaseService, type CommonServiceParams } from "@/services/base.service.js";
import { getLive, isNodeOffline } from "@/services/nodes/node-registry.js";
import { isNodeOfflineError } from "@/services/nodes/remote-launcher.js";
import { getNotifyService, type NotifyKind } from "@/services/notify.service.js";
import { readSessionLogTail, SessionManagerService } from "@/services/session-manager.service.js";
import { extendSessionToken, sessionTokenTtlSeconds } from "@/services/session-tokens.js";

/** The kinds a harness may self-report through the attention endpoint. */
export type AttentionKind = Extract<NotifyKind, "turn_complete" | "needs_attention">;

/** Session view shape returned by the manager (single source: toSessionView). */
type SessionView = NonNullable<Awaited<ReturnType<SessionManagerService["getSession"]>>>;

/** A sharing grant as returned to the client, with the grantee label resolved. */
interface SessionShareView {
  /** Share row id */
  id: string;
  /** Grantee user id, or null for the Everyone grant */
  granteeUserId: string | null;
  /** Display name ("Everyone" for the null grant; the id if the user is gone) */
  granteeName: string | null;
  /** Access level this grant confers */
  permission: SessionSharePermission;
}

/** Route error with an HTTP status; Elysia maps `status` to the response code. */
class SessionCreateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Thrown when a session (or its owner-visible surface) does not exist; maps to 404. */
class SessionError extends Error {
  readonly code: string;
  readonly status = 404;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Map an offline-flavored manager throw onto the structured 409 NODE_OFFLINE
 * of spec §5.6 (the pane may still be running on the node — the row is the
 * UI's truth again). Every other error keeps whatever mapping it had: the
 * rethrow rides the global handler unchanged.
 * @throws ApiError 409 NODE_OFFLINE (doNotLog — an expected 4xx class)
 */
function rethrowUnlessNodeOffline(err: unknown): never {
  if (isNodeOfflineError(err)) {
    throwApiError({
      code: BackendErrorCodes.NODE_OFFLINE,
      message: "The session's node has no live agent connection — it may still be running the session there",
      doNotLog: true,
    });
  }
  throw err;
}

/**
 * THE launch-node decision for a new session (spec 2026-08-31 §6.6), in
 * strict precedence — a request that says where to run is never silently
 * relocated:
 *
 * 1. `requestedNodeId` (body) — gate it: row absent OR invisible ⇒ 404,
 *    never 403 (spec §2: any share level grants launch, so a visible node is
 *    always launchable and a 403 would be a node-id existence oracle); an
 *    AGENT node with no live connection ⇒ 409 NODE_OFFLINE.
 * 2. `profile.nodeId` (the pin) — the same gate, but every failure carries
 *    the "profile is pinned" message: a pin that cannot launch right now is
 *    an error, never a relocation.
 * 3. `local` when its own access check grants launch — today's default, and
 *    the disable-switch (an admin deleting local's Everyone row turns this
 *    step off for non-owners).
 * 4. Auto-pick: exactly one ONLINE agent among the caller's candidates —
 *    `findAccessible` for a browser actor, `listByOwner` for a bearer. Zero
 *    or several ⇒ 400 NODE_REQUIRED ("pick one"; the spec's single-online
 *    auto-pick is read literally — two online nodes is NOT a choice).
 *
 * MACHINE actors (`machineActor: true` — any bearer token, session or
 * system key) get the STRICT loader everywhere: no admin boost, no shares,
 * owner-only — so a leaked harness key can never spawn a control-plane
 * session (local belongs to the system user) nor ride a shared node.
 *
 * @param deps - the repositories the access resolver reads (nodes, shares,
 *               userMeta) — injected so tests drive a scratch DB
 * @returns the node id to launch on (`local` = control-plane host)
 * @throws SessionCreateError 404 (absent/invisible — never 403, spec §2);
 *         ApiError 409 NODE_OFFLINE (offline gate) and 400 NODE_REQUIRED
 *         (auto-pick)
 */
export async function resolveLaunchNode(
  {
    userId,
    machineActor,
    requestedNodeId,
    profile,
  }: {
    /** The creating user (bearer actors arrive as their owning user). */
    userId: string;
    /** True for every non-cookie actor — switches off admin boost + shares. */
    machineActor: boolean;
    /** Explicit `body.nodeId` (may name `local`). */
    requestedNodeId?: string;
    /** The resolved profile row — only `nodeId` (the pin) is read. */
    profile: { nodeId: string | null };
  },
  deps: NodeAccessDeps,
): Promise<{ nodeId: string }> {
  /** The steps 1/2 gate: existence → launch access → agent liveness. */
  const gate = async (nodeId: string, pinned: boolean): Promise<{ nodeId: string }> => {
    const { row, access } = await loadNodeAccess(deps, userId, nodeId, { allowAdminAndShares: !machineActor });
    const why = pinned ? `Profile is pinned to node ${nodeId}, which can't launch right now` : undefined;
    // any share grants launch (spec §2): access "none" ⇔ invisible ⇒ 404; no visible-but-unlaunchable state exists
    if (!row || !nodeCanLaunch(access)) {
      throw new SessionCreateError("node_not_found", why ?? "Node not found", 404);
    }
    if (row.kind === "agent" && !getLive(nodeId)) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: why ?? "That node has no live agent connection",
        doNotLog: true,
      });
    }
    return { nodeId };
  };

  if (requestedNodeId) return gate(requestedNodeId, false);
  if (profile.nodeId) return gate(profile.nodeId, true);

  // Step 3: the control-plane host, via the same gate (its seeded Everyone/
  // edit share is the launch switch; its absence relocates to step 4).
  const local = await loadNodeAccess(deps, userId, LOCAL_NODE_ID, { allowAdminAndShares: !machineActor });
  if (local.row && nodeCanLaunch(local.access)) return { nodeId: LOCAL_NODE_ID };

  // Step 4: single-online-agent auto-pick over the actor's candidate set.
  const candidates = machineActor ? await deps.nodes.listByOwner(userId) : await deps.nodes.findAccessible(userId);
  const online = candidates.filter((n) => n.kind === "agent" && getLive(n.id));
  if (online.length === 1) return { nodeId: online[0].id };
  throwApiError({
    code: BackendErrorCodes.NODE_REQUIRED,
    message:
      online.length === 0
        ? "No launch-eligible node — pick one"
        : `Multiple online nodes — pick one explicitly (${online.length} are online)`,
    doNotLog: true,
  });
}

/**
 * Business logic behind `/api/sessions`, one method per endpoint.
 *
 * A thin layer over {@link SessionManagerService} (the session lifecycle truth,
 * built once per service instance — not per call) plus the profile/harness
 * gating and permission-adjacent checks the HTTP surface needs. Errors ride
 * the global error handler as `status`-carrying classes.
 */
export class SessionsService extends BaseService {
  /** Built once per request (not once per call) from the context's repositories. */
  readonly #manager: SessionManagerService;

  constructor(params: CommonServiceParams) {
    super(params);
    this.#manager = new SessionManagerService({
      sessions: params.repos.sessions,
      profiles: params.repos.profiles,
    });
  }

  /**
   * Creates a new agent session (starts the harness on the node §6.6
   * resolves — control-plane host unless stated otherwise) and returns only
   * the client-safe fields — the MCP apiKey is issued once inside the
   * manager for env injection and is NEVER echoed to the HTTP client.
   * @throws SessionCreateError 404 when the profile is absent, or the
   *         requested/pinned node is absent OR invisible (spec §2: 404-not-403
   *         — an invisible node never answers 403).
   * @throws ApiError 409 NODE_OFFLINE (agent node unreachable), 400
   *         NODE_REQUIRED (no launch-eligible node), 409 when the profile's
   *         harness is disabled/unusable ON THE RESOLVED NODE.
   */
  async createSession({
    userId,
    profileId,
    workingDir,
    name,
    prompt,
    nodeId,
    machineActor,
  }: {
    /** Owner of the new session (never taken from the body). */
    userId: string;
    /** Profile to use for this session. */
    profileId: string;
    /** Absolute working directory. */
    workingDir: string;
    /** Optional session display name. */
    name?: string;
    /** Optional task text typed into the pane once the harness settles. */
    prompt?: string;
    /** Node to launch on (spec §6.6); omitted/`local` = control-plane host. */
    nodeId?: string;
    /**
     * True for any bearer (non-cookie) actor — enforced by the user-ratified
     * STRICT rule: bearer creation resolves nodes with no admin boost and no
     * shares, owner-only, the implicit `local` fallback included.
     */
    machineActor: boolean;
  }): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    // Gate new sessions here, not inside SessionManagerService: its own
    // restart path reuses createSession, and an existing session's harness
    // must keep starting even once its harness is disabled.
    const profile = await this.repos.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new SessionCreateError("not_found", "Profile not found", 404);
    }
    // §6.6 precedence BEFORE the harness gate: "where" must be settled first,
    // since "usable" is per-node now (spec §6.2).
    const { nodeId: resolvedNodeId } = await resolveLaunchNode(
      { userId, machineActor, requestedNodeId: nodeId, profile },
      { nodes: this.repos.nodes, shares: this.repos.nodeShares, userMeta: this.repos.userMeta },
    );
    if (!(await harnessUsable(profile.harnessId, resolvedNodeId))) {
      // Copy honesty: on an AGENT node "this machine" is a lie — the harness
      // may simply not be installed there (spec §6.2 per-node inventory). The
      // local wording stays verbatim — legacy tests pin it.
      throw new SessionCreateError(
        "harness_disabled",
        resolvedNodeId === LOCAL_NODE_ID
          ? "That harness is disabled on this machine"
          : "That harness is disabled or not installed on that node",
        409,
      );
    }
    // The manager already rolled the row + token back; a node that dropped
    // offline between resolution and launch answers with the same structured
    // 409 the restart boundary gives (§5.6) — everything else rethrows.
    const created = await this.#manager
      .createSession({
        userId,
        profileId,
        workingDir,
        name,
        prompt,
        nodeId: resolvedNodeId,
        // Notifications default ON for new sessions (spec 2026-08-31); the
        // per-user master switch still gates the actual send, and the
        // operator can mute an individual session with its bell.
        notify: true,
      })
      .catch(rethrowUnlessNodeOffline);
    // Feed the picker's Recents (and the new-session form's pre-fill) from
    // real use — scoped to the node the session actually launched on, so a
    // remote machine's paths never surface in the local picker (and vice
    // versa). Best-effort: the session EXISTS at this point, and a book-
    // keeping insert failing must not turn a successful launch into an error.
    await this.repos.recentPaths.touch(userId, workingDir, name ?? null, resolvedNodeId).catch(() => {});
    // The MCP apiKey is returned by the manager for env injection only; it is
    // a secret issued once and NEVER echoed to the HTTP client.
    return { id: created.id, tmuxSocket: created.tmuxSocket, promptDelivered: created.promptDelivered };
  }

  /**
   * Lists every session the caller can SEE — their own plus those shared with
   * Everyone or with them by name (all for an admin) — as manager-reconciled
   * views carrying the caller's viewer-relative `access`. A private foreign
   * session is simply absent, never a 403.
   * @param viewerId - The signed-in user (resolved from cookie or session key)
   */
  async listSessions(viewerId: string): Promise<SessionView[]> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    const rows = await this.repos.sessions.listVisibleTo(viewerId, isAdmin);
    const sharesBy = await this.repos.sessionShares.listForSessions(rows.map((r) => r.id));
    // Resolve access per row (needs the owner id, which the view doesn't carry),
    // keyed by id so the view mapping stays a plain lookup. A visible row always
    // resolves to view/edit/owner; "none" is impossible here but the type
    // carries it, so the fallback names the weakest real access.
    const accessBy = new Map<string, Exclude<Access, "none">>();
    for (const row of rows) {
      const access = resolveSessionAccess(viewerId, isAdmin, row.userId, sharesBy.get(row.id) ?? []);
      accessBy.set(row.id, access === "none" ? "view" : access);
    }
    const views = await this.#manager.toViews(rows);
    return views.map((view) => ({
      ...view,
      access: accessBy.get(view.id) ?? ("view" as const),
    }));
  }

  /**
   * Waiting/running counts over the visible set (own + shared; all for an
   * admin) — the same sessions {@link listSessions} returns, reduced to the
   * badge numbers for the native tab and push payloads. The blessed
   * `isNodeOffline` predicate is passed so a waiting session behind an
   * unreachable node does not count as waiting (F1); `running`/`total` are
   * unaffected.
   * @param viewerId - The signed-in user whose visible set to count
   */
  async summarySessions(viewerId: string): Promise<{ total: number; running: number; waiting: number }> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    return await this.repos.sessions.countsVisibleTo(viewerId, isAdmin, isNodeOffline);
  }

  /**
   * Loads a session and enforces that `viewerId` holds at least `min` access,
   * the single policy point for every per-session route.
   *
   * A bearer (session-key) actor is treated as its owner and NOTHING more: the
   * admin boost and shared grants are switched off for it, so a machine token
   * can never act on a foreign or shared session — exactly the strictness the
   * pre-sharing owner check had. Absent/invisible → 404 (`not_found`, no
   * existence leak); visible-but-insufficient → 403.
   *
   * @returns the session row (caller uses `row.userId` as the owner when it
   *          hands off to the owner-keyed manager) and the resolved access
   */
  async #gate(
    viewerId: string,
    sessionId: string,
    min: Exclude<Access, "none">,
    actor: GuardActor,
  ): Promise<{ row: SessionTable; access: Access }> {
    const { row, access } = await loadSessionAccess(
      { sessions: this.repos.sessions, shares: this.repos.sessionShares, userMeta: this.repos.userMeta },
      viewerId,
      sessionId,
      { allowAdminAndShares: actor !== "session-key" },
    );
    if (!row || access === "none") throw new SessionError("not_found", "Session not found");
    if (!accessAtLeast(access, min)) {
      throw new HttpError(403, "You do not have permission to do that with this session");
    }
    return { row, access };
  }

  /**
   * Gets a single session view for the viewer — their own or one shared to
   * them — stamped with the viewer's own `access`.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 is impossible at `view` (visible ⇒ at least view).
   */
  async getSession(viewerId: string, id: string, actor: GuardActor): Promise<SessionView> {
    const { row, access } = await this.#gate(viewerId, id, "view", actor);
    // Build the view under the OWNER's id (the manager is owner-keyed); the
    // caller never sees the owner id, only their resolved access level.
    const session = await this.#manager.getSession(row.userId, id);
    if (!session) throw new SessionError("not_found", "Session not found");
    return { ...session, access: access === "none" ? "view" : access };
  }

  /**
   * Tail of the session's pane log (ANSI-stripped) — why a harness exited, if it did.
   *
   * Gated at `view`, the same level as GET /:id, so a stranger gets a 404 and
   * the log's contents never leak through timing or body differences.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws ApiError 409 NODE_OFFLINE when the row's agent node has no live
   *         connection (spec §5.6, the create/restart mapping again — the UI
   *         polls this tail, so an offline node must answer 409, never a 500
   *         plus a server-error log line per poll).
   */
  async getSessionLogTail(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    const { row } = await this.#gate(viewerId, id, "view", actor);
    // Spec §6.5: the tail reads from the node that owns the pane — an
    // agent-node row goes through its RemoteLauncher (`log_read` window),
    // whose offline throw maps onto §5.6 exactly like create/restart.
    return await readSessionLogTail(id, row.nodeId).catch(rethrowUnlessNodeOffline);
  }

  /**
   * Sets or clears a session note (an `edit` act).
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async updateSessionNotes(
    viewerId: string,
    id: string,
    notes: string | null,
    actor: GuardActor,
  ): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const ok = await this.#manager.updateNotes(row.userId, id, notes);
    if (!ok) throw new SessionError("not_found", "Session not found");
    return { ok: true };
  }

  /**
   * Renames a session (which also locks the name against the pane-title
   * sweep) — an `edit` act. Validation (non-blank, length) is the route's job.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async renameSession(viewerId: string, id: string, name: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const ok = await this.#manager.updateName(row.userId, id, name);
    if (!ok) throw new SessionError("not_found", "Session not found");
    return { ok: true };
  }

  /**
   * Turns pane-title auto-naming on/off for a session — an `edit` act.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async setSessionAutoTitle(viewerId: string, id: string, enabled: boolean, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const ok = await this.#manager.setNameLocked(row.userId, id, !enabled);
    if (!ok) throw new SessionError("not_found", "Session not found");
    return { ok: true };
  }

  /**
   * Sets how many trailing log lines a terminal replays when attaching to
   * this session — an `edit` act (it is session config, like rename/notes).
   * `null` clears the per-session choice so the instance default
   * (`MOTE_TERMINAL_REPLAY_LINES`) applies again. Clamping [1, 200] is the
   * route's schema job; this stores what it validated.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async setSessionReplayLines(
    viewerId: string,
    id: string,
    lines: number | null,
    actor: GuardActor,
  ): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    await this.repos.sessions.update(row.id, { terminalReplayLines: lines });
    return { ok: true };
  }

  /**
   * Rings or mutes a session's notifications (the ⋯-menu bell) — OWNER-only
   * (it changes what leaves the instance for the owner's devices). Muting stops
   * pushes only; the waiting stamp is deliberately untouched.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner.
   */
  async setSessionNotify(viewerId: string, id: string, notify: boolean, actor: GuardActor): Promise<{ ok: true }> {
    await this.#gate(viewerId, id, "owner", actor);
    await this.repos.sessions.update(id, { notify: notify ? 1 : 0 });
    return { ok: true };
  }

  /** The current grants on a session, with grantee names resolved for display. */
  async #shareViews(sessionId: string): Promise<SessionShareView[]> {
    const rows = await this.repos.sessionShares.listForSession(sessionId);
    const named = rows.map((r) => r.granteeUserId).filter((x): x is string => x !== null);
    const names = await this.repos.users.displayNamesByIds(named);
    return rows.map((r) => ({
      id: r.id,
      granteeUserId: r.granteeUserId,
      granteeName: r.granteeUserId === null ? "Everyone" : (names.get(r.granteeUserId) ?? r.granteeUserId),
      permission: r.permission,
    }));
  }

  /**
   * Lists a session's sharing grants — OWNER-only (managing who can see a
   * session is the owner's act; an admin's effective `edit` does not extend here).
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner.
   */
  async getShares(viewerId: string, id: string, actor: GuardActor): Promise<{ shares: SessionShareView[] }> {
    await this.#gate(viewerId, id, "owner", actor);
    return { shares: await this.#shareViews(id) };
  }

  /**
   * Replaces a session's whole grant set — OWNER-only. Each non-null grantee
   * must be an existing user (else 400); a null/absent grantee is the Everyone
   * grant. Returns the resulting set (with names). The creator recorded on each
   * row is the acting owner.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner; 400 on an unknown grantee.
   */
  async setShares(
    viewerId: string,
    id: string,
    entries: ShareEntry[],
    actor: GuardActor,
  ): Promise<{ shares: SessionShareView[] }> {
    await this.#gate(viewerId, id, "owner", actor);
    const named = entries.map((e) => e.granteeUserId).filter((x): x is string => x !== null);
    if (named.length > 0) {
      const names = await this.repos.users.displayNamesByIds(named);
      const unknown = named.find((uid) => !names.has(uid));
      if (unknown) throw new HttpError(400, "Cannot share with an unknown user");
    }
    await this.repos.sessionShares.replaceForSession(id, entries, viewerId);
    return { shares: await this.#shareViews(id) };
  }

  /**
   * A harness reports it needs attention (hook delivery). Sets the waiting
   * stamp and rings — the bell gate lives inside notifySession so this path
   * is unconditional here.
   *
   * A DEAD row silently drops the event: a hook POST in flight while the
   * pane dies arrives after the reconcile sweep cleared `waiting_since`, and
   * stamping then would resurrect a false "waiting for you" chip on a dead
   * (possibly auto-restarting, same-id) row. The caller still sees 200 —
   * hooks are fire-and-forget, and a 4xx there buys nothing.
   */
  async recordAttention(id: string, kind: AttentionKind): Promise<void> {
    const row = await this.repos.sessions.findById(id);
    if (row?.alive !== 1) return;
    await this.repos.sessions.update(id, { waitingSince: new Date().toISOString() });
    await getNotifyService().notifySession(id, kind);
  }

  /**
   * Revives a session IN PLACE (same id, same row): the manager kills the
   * pane and re-runs the auto-restart's guarded respawn on this row,
   * resuming the harness conversation when its transcript survived.
   * Deliberately does NOT re-check harness usability — the gate lives on
   * creation and the auto path; a session whose harness was disabled later
   * can still be restarted.
   * @throws SessionError 404 when absent/invisible to the caller, or when a
   *         terminate/delete won the restart race (converge on "gone").
   * @throws HttpError 403 when the caller holds only `view`.
   * @throws ApiError 409 NODE_OFFLINE when the row's agent node has no live
   *         connection (spec §5.6) — the manager has already rolled the
   *         parked row back and retired the token before this boundary.
   */
  async restartSession(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const revived = await this.#manager.restartSession(row.userId, id).catch(rethrowUnlessNodeOffline);
    if (!revived) {
      throw new SessionError("not_found", "Session not found");
    }
    // No prompt is typed on a restart (matching auto-restart); the schema
    // keeps the create-session shape, so the flag is a truthful false.
    return { id: revived.id, tmuxSocket: revived.tmuxSocket, promptDelivered: false };
  }

  /**
   * Terminates a session (kills the harness process tree) — an `edit` act. A
   * missing/invisible session is a 404 via the gate; a view-only grantee a 403.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller holds only `view`.
   */
  async terminateSession(viewerId: string, id: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    await this.#manager.terminateSession(row.userId, id);
    return { ok: true };
  }

  /**
   * Resets this session's MCP token expiry.
   *
   * Only the session's own token (or its owner's cookie) may self-extend —
   * a session can never widen another's lifetime.
   * @throws SessionError 404 when the session is absent or not the user's.
   * @throws HttpError 403 when a session key tries to extend another session.
   */
  async extendSessionToken({
    userId,
    sessionId,
    actor,
    principal,
  }: {
    /** Owner resolved by the auth guard. */
    userId: string;
    /** Session whose token should be refreshed. */
    sessionId: string;
    /** How the request authenticated. */
    actor: GuardActor;
    /** Guard principal (`sess:<id>` for session keys, `user:<id>` otherwise). */
    principal: string;
  }): Promise<{ extended: boolean; ttlSeconds: number }> {
    const row = await this.repos.sessions.findById(sessionId);
    if (!row || row.userId !== userId) {
      throw new SessionError("not_found", "Session not found");
    }
    if (actor === "session-key" && principal !== `sess:${sessionId}`) {
      throw new HttpError(403, "A session token may only extend its own lifetime");
    }
    const extended = await extendSessionToken(sessionId);
    return { extended, ttlSeconds: sessionTokenTtlSeconds() };
  }

  /**
   * Deletes a session (terminates first if running) — OWNER-only.
   * @throws SessionError 404 when absent or invisible to the caller.
   * @throws HttpError 403 when the caller is not the owner (view/edit included).
   */
  async deleteSession(viewerId: string, id: string, actor: GuardActor): Promise<{ ok: true }> {
    const { row } = await this.#gate(viewerId, id, "owner", actor);
    const ok = await this.#manager.deleteSession(row.userId, id);
    if (!ok) {
      throw new SessionError("not_found", "Session not found");
    }
    return { ok: true };
  }
}
