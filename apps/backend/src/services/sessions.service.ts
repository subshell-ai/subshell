import type { GuardActor } from "@/api/auth-guard.js";
import { HttpError } from "@/api/auth-guard.js";
import { harnessUsable } from "@/api/harness-utils.js";
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
    });
    // Feed the picker's Recents (and the new-session form's pre-fill) from
    // real use. Best-effort: the session EXISTS at this point, and a book-
    // keeping insert failing must not turn a successful launch into an error.
    await this.repos.recentPaths.touch(userId, workingDir, name ?? null).catch(() => {});
    // The MCP apiKey is returned by the manager for env injection only; it is
    // a secret issued once and NEVER echoed to the HTTP client.
    return { id: created.id, tmuxSocket: created.tmuxSocket, promptDelivered: created.promptDelivered };
  }

  /** Lists the user's sessions (manager-reconciled views). */
  async listSessions(userId: string): Promise<SessionView[]> {
    return await this.#manager.listSessions(userId);
  }

  /**
   * Waiting/running counts for the native app's tab badge and push payloads
   * (same rows the list reconciles would show; counts come straight from the
   * table — badge correctness beats view reconciliation cost here).
   * @param userId - Owner whose sessions are counted
   */
  async summarySessions(userId: string): Promise<{ total: number; running: number; waiting: number }> {
    return await this.repos.sessions.countsByUser(userId);
  }

  /**
   * Gets a single session view for the user.
   * @throws SessionError 404 when absent or owned by someone else.
   */
  async getSession(userId: string, id: string): Promise<SessionView> {
    const session = await this.#manager.getSession(userId, id);
    if (!session) {
      throw new SessionError("not_found", "Session not found");
    }
    return session;
  }

  /**
   * Tail of the session's pane log (ANSI-stripped) — why a harness exited, if it did.
   *
   * The existence check doubles as the visibility guard (owner-only, like
   * GET /:id) so a foreign session is a 404, and the log's contents
   * never leak through timing or body differences.
   * @throws SessionError 404 when absent or owned by someone else.
   */
  async getSessionLogTail(userId: string, id: string): Promise<{ lines: string[]; truncated: boolean }> {
    const session = await this.#manager.getSession(userId, id);
    if (!session) {
      throw new SessionError("not_found", "Session not found");
    }
    return await readSessionLogTail(id);
  }

  /**
   * Sets or clears a session note.
   * @throws SessionError 404 when absent or owned by someone else.
   */
  async updateSessionNotes(userId: string, id: string, notes: string | null): Promise<{ ok: true }> {
    const ok = await this.#manager.updateNotes(userId, id, notes);
    if (!ok) {
      throw new SessionError("not_found", "Session not found");
    }
    return { ok: true };
  }

  /**
   * Renames a session (which also locks the name against the pane-title
   * sweep). Validation (non-blank, length) is the route's job.
   * @throws SessionError 404 when the session is absent or not the caller's.
   */
  async renameSession(userId: string, id: string, name: string): Promise<{ ok: true }> {
    const ok = await this.#manager.updateName(userId, id, name);
    if (!ok) {
      throw new SessionError("not_found", "Session not found");
    }
    return { ok: true };
  }

  /**
   * Turns pane-title auto-naming on/off for a session.
   * @throws SessionError 404 when the session is absent or not the caller's.
   */
  async setSessionAutoTitle(userId: string, id: string, enabled: boolean): Promise<{ ok: true }> {
    const ok = await this.#manager.setNameLocked(userId, id, !enabled);
    if (!ok) {
      throw new SessionError("not_found", "Session not found");
    }
    return { ok: true };
  }

  /**
   * Rings or mutes a session's notifications (the ⋯-menu bell). Muting
   * stops pushes only — the waiting stamp is deliberately untouched.
   * @returns false when the session is absent or not the caller's (route maps to 404).
   */
  async setSessionNotify(userId: string, id: string, notify: boolean): Promise<boolean> {
    const row = await this.repos.sessions.findById(id);
    if (!row || row.userId !== userId) return false;
    await this.repos.sessions.update(id, { notify: notify ? 1 : 0 });
    return true;
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
   * @throws SessionError 404 when the session is absent/not the caller's, or
   *         a terminate/delete won the restart race (converge on "gone").
   */
  async restartSession(
    userId: string,
    id: string,
  ): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const revived = await this.#manager.restartSession(userId, id);
    if (!revived) {
      throw new SessionError("not_found", "Session not found");
    }
    // No prompt is typed on a restart (matching auto-restart); the schema
    // keeps the create-session shape, so the flag is a truthful false.
    return { id: revived.id, tmuxSocket: revived.tmuxSocket, promptDelivered: false };
  }

  /**
   * Terminates a session (kills the harness process tree). Matches the
   * manager's semantics exactly: a missing/foreign session is a silent no-op,
   * not a 404.
   */
  async terminateSession(userId: string, id: string): Promise<{ ok: true }> {
    await this.#manager.terminateSession(userId, id);
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
   * Deletes a session (terminates first if running).
   * @throws SessionError 404 when absent or owned by someone else.
   */
  async deleteSession(userId: string, id: string): Promise<{ ok: true }> {
    const ok = await this.#manager.deleteSession(userId, id);
    if (!ok) {
      throw new SessionError("not_found", "Session not found");
    }
    return { ok: true };
  }
}
