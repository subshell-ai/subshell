/**
 * Hand-written mirrors of the API response shapes, matching the frontend's
 * convention (`apps/frontend/AGENTS.md`: `src/types/` = hand-written mirrors).
 *
 * `@internal/backend-client` is deliberately NOT used at runtime: its
 * package.json carries `elysia` as a *dependency*, so importing the Treaty
 * client would pull the server framework into the Hermes bundle. Types only may
 * be imported with `import type { App } from "@internal/backend-client"` if a
 * later milestone wants inference instead of these mirrors.
 *
 * Field list tracks `SessionSchema` in `apps/backend/src/api/models.ts:29-53`.
 */

/** Lifecycle status persisted on the session row. */
export type SessionStatus = "running" | "terminated";

/** Derived activity state: running with recent output, running and quiet, dead. */
export type SessionActivity = "active" | "idle" | "terminated";

/**
 * The caller's effective access to a session (viewer-relative, spec §4). Never
 * "none" on a returned row. `view` = watch read-only; `edit` = interact +
 * manage; `owner` = full control incl. the bell and deletion.
 */
export type SessionAccess = "owner" | "edit" | "view";

/**
 * One session as the API returns it — the single source of truth for every
 * screen, list row, chip and badge in this app.
 */
export interface SessionView {
  /** Session id (uuid). Restart revives the row in place: the id survives. */
  id: string;
  /** Profile the session was launched from. */
  profileId: string;
  /** Harness plugin id, e.g. `claude-code`. */
  harnessId: string;
  /**
   * Node the session runs on ("local" = control-plane host, spec
   * 2026-08-31 §3). The backend always sends it; optional so older payloads
   * keep typechecking — no mobile UI reads it yet.
   */
  nodeId?: string;
  /**
   * True = the session's agent node has no live connection (spec §5.6) — the
   * session may still be RUNNING there, its state is just unobservable from
   * here, so the exited/crash copy must say "node unreachable" instead.
   * Optional so older payloads keep typechecking: `undefined` reads as
   * online-ish and must NEVER render "node unreachable" (test with
   * `=== true`). Always false for sessions on `local`.
   */
  nodeOffline?: boolean;
  /** Display name; may be auto-mirrored from the pane title. */
  name: string;
  /** Absolute working directory on the instance's host. */
  workingDir: string;
  /** Persisted lifecycle status. */
  status: SessionStatus;
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO death timestamp, null while alive. */
  endedAt: string | null;
  /** ISO timestamp of the last pane output. */
  lastOutputAt: string | null;
  /** Operator note. */
  notes: string | null;
  /** Rough activity state. */
  activity: SessionActivity;
  /** Bottom ≤20 screen lines, ANSI-styled, running sessions only — strip before display. */
  preview: string[];
  /** False once the pane process has exited (crashed or paused). */
  alive: boolean;
  /** Harness exit status, null while alive. */
  exitCode: number | null;
  /** ISO timestamp of the last process start. */
  startedAt: string | null;
  /** Consecutive auto-restarts so far. */
  backoffCount: number;
  /** True = auto-restart on exit. */
  restartOnExit: boolean;
  /** ISO timestamp the backoff restart is due, null when none armed. */
  nextRestartAt: string | null;
  /** True = operator-named; false = pane-title auto-naming owns the name. */
  nameLocked: boolean;
  /** True = the bell is on: pushes and waiting-first ordering. */
  notify: boolean;
  /**
   * ISO timestamp of the attention event that put this session in
   * "waiting for you", null when not waiting. THE badge source — stamped by
   * harness hooks or the idle watcher, cleared on output resume or death.
   */
  waitingSince: string | null;
  /** The caller's effective access (drives which actions + live input are allowed). */
  access: SessionAccess;
}

/** Tail of a session's pane log (`GET /api/sessions/:id/log`). */
export interface SessionLogTail {
  /** Oldest first. ANSI already stripped server-side. */
  lines: string[];
  /** True when older output existed but was cut from the response. */
  truncated: boolean;
}

/** Counts for the tab badge and the push payload (`GET /api/sessions/summary`). */
export interface SessionSummary {
  /** Sessions the user has ever had. */
  total: number;
  /** Sessions currently alive. */
  running: number;
  /** Alive sessions with `waitingSince` set — the badge number. */
  waiting: number;
}

/** Response of `POST /api/auth/ws-token` — single-use, 30 s TTL. */
export interface WsTokenResponse {
  /** One-shot attach token for `/ws` and `/api/events`. */
  token: string;
}

/** Response of `POST /api/auth/sign-in/email`. The BODY token is the UNSIGNED
 * one — better-auth 1.7.x only accepts the signed "<token>.<sig>" value from
 * Set-Cookie as a credential; SubshellClient stores that instead (b0743b8). */
export interface SignInResponse {
  /** Unsigned body token — a fallback ONLY; the signed Set-Cookie value is
   * the credential (see the interface doc above and SubshellClient.signIn). */
  token: string;
  /** Redirect target for OAuth flows; unused here. */
  url?: string | null;
  /** Whether the client should redirect. */
  redirect?: boolean;
  /** The signed-in user. */
  user?: { id?: string; name?: string; email?: string };
}
