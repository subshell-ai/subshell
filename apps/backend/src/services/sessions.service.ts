import type { GuardActor } from "@/api/auth-guard.js";
import { HttpError } from "@/api/auth-guard.js";
import { harnessUsable } from "@/api/harness-utils.js";
import type { SessionTable } from "@/db/types/sessions.db-types.js";
import { type Access, accessAtLeast, loadSessionAccess, resolveSessionAccess } from "@/lib/session-access.js";
import { BaseService, type CommonServiceParams } from "@/services/base.service.js";
import { getNotifyService, type NotifyKind } from "@/services/notify.service.js";
import { readSessionLogTail, SessionManagerService } from "@/services/session-manager.service.js";
import { extendSessionToken, sessionTokenTtlSeconds } from "@/services/session-tokens.js";

/** The kinds a harness may self-report through the attention endpoint. */
export type AttentionKind = Extract<NotifyKind, "turn_complete" | "needs_attention">;

/** Session view shape returned by the manager (single source: toSessionView). */
type SessionView = NonNullable<Awaited<ReturnType<SessionManagerService["getSession"]>>>;

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
   * Creates a new agent session (starts the harness under tmux) and returns
   * only the client-safe fields — the MCP apiKey is issued once inside the
   * manager for env injection and is NEVER echoed to the HTTP client.
   * @throws SessionCreateError 404 when the profile is absent or not the caller's.
   * @throws SessionCreateError 409 when the profile's harness is disabled/unusable.
   */
  async createSession({
    userId,
    profileId,
    workingDir,
    name,
    prompt,
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
  }): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    // Gate new sessions here, not inside SessionManagerService: its own
    // restart path reuses createSession, and an existing session's harness
    // must keep starting even once its harness is disabled.
    const profile = await this.repos.profiles.findById(profileId);
    if (!profile || profile.userId !== userId) {
      throw new SessionCreateError("not_found", "Profile not found", 404);
    }
    if (!(await harnessUsable(profile.harnessId))) {
      throw new SessionCreateError("harness_disabled", "That harness is disabled on this machine", 409);
    }
    const created = await this.#manager.createSession({
      userId,
      profileId,
      workingDir,
      name,
      prompt,
      // Notifications default ON for new sessions (spec 2026-08-31); the
      // per-user master switch still gates the actual send, and the operator
      // can mute an individual session with its bell.
      notify: true,
    });
    // Feed the picker's Recents (and the new-session form's pre-fill) from
    // real use. Best-effort: the session EXISTS at this point, and a book-
    // keeping insert failing must not turn a successful launch into an error.
    await this.repos.recentPaths.touch(userId, workingDir, name ?? null).catch(() => {});
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
    return this.#manager.toViews(rows).map((view) => ({
      ...view,
      access: accessBy.get(view.id) ?? ("view" as const),
    }));
  }

  /**
   * Waiting/running counts over the visible set (own + shared; all for an
   * admin) — the same sessions {@link listSessions} returns, reduced to the
   * badge numbers for the native tab and push payloads.
   * @param viewerId - The signed-in user whose visible set to count
   */
  async summarySessions(viewerId: string): Promise<{ total: number; running: number; waiting: number }> {
    const isAdmin = (await this.repos.userMeta.getRole(viewerId)) === "admin";
    return await this.repos.sessions.countsVisibleTo(viewerId, isAdmin);
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
   */
  async getSessionLogTail(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ lines: string[]; truncated: boolean }> {
    await this.#gate(viewerId, id, "view", actor);
    return await readSessionLogTail(id);
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
   */
  async restartSession(
    viewerId: string,
    id: string,
    actor: GuardActor,
  ): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const { row } = await this.#gate(viewerId, id, "edit", actor);
    const revived = await this.#manager.restartSession(row.userId, id);
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
