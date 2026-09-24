import { randomUUID, timingSafeEqual } from "node:crypto";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { logger } from "@/utils/logger.js";

/**
 * Audit hooks for the better-auth integration (security audit 2026-09 item R1;
 * the gap §10 of `docs/security.md` used to call "known").
 *
 * Two events, one act each:
 *
 * - `auth.sign_in` — written from `hooks.after` when a sign-in ENDPOINT
 *   succeeded. The actor and target are the user id from the endpoint's
 *   RESULT, never its request body, and the metadata carries only
 *   `{ method }`. A failed sign-in writes nothing: credential-stuffing would
 *   otherwise spam the trail that exists to reconstruct incidents, and
 *   failures already live in the login-backoff domain (`authAttempts` +
 *   the rate-limit route's log lines).
 * - `auth.sign_out` — written from `databaseHooks.session.delete.after`,
 *   which fires exactly when a session row is ACTUALLY deleted (the hook runs
 *   per found entity, so a sign-out against an already-dead cookie deletes
 *   nothing and writes nothing). This seam was chosen over `hooks.after` on
 *   `/sign-out` because that endpoint loads no session for the hook context
 *   and answers `{ success: true }` even when nobody was signed in — from
 *   inside it the act has no actor to name.
 *
 * What is deliberately NOT in a row: session tokens, cookie values, emails,
 * IPs, User-Agents. Ids and the method, nothing else — an audit row is the
 * thing that gets screenshotted into an issue (`GET /api/admin/status` holds
 * the same rule).
 */

/** How the credential was presented, recorded in `auth.sign_in` metadata. */
export type SignInMethod = "password" | "passkey";

/**
 * The endpoint paths whose successful completion is an audited sign-in, with
 * the method each names. These are the exact path strings of the installed
 * better-auth 1.7.1: core's email sign-in (`dist/api/routes/sign-in.mjs`) and
 * the passkey plugin's authentication verify
 * (`@better-auth/passkey/dist/index.mjs` — passkey sign-in runs through
 * `/passkey/verify-authentication`, there is no `/sign-in/passkey`).
 */
export const SIGN_IN_ENDPOINT_METHODS: Record<string, SignInMethod> = {
  "/sign-in/email": "password",
  "/passkey/verify-authentication": "passkey",
};

/**
 * The break-glass dedupe, one act = one row. An approved emergency login
 * already writes `emergency_login.rewrite_credential` (the more informative
 * name — it says the credential was rewritten, which is the act); the
 * forwarded sign-in that follows would also satisfy `hooks.after`, so the
 * rewrite marks the act here and the sign-in hook consumes the mark instead
 * of writing `auth.sign_in`.
 *
 * The mark binds to its ACT, not to the user's next sign-in. A userId-keyed
 * flag meant any successful password sign-in by that admin within the TTL
 * could consume it — a genuine sign-in that interleaved with an
 * armed mark (the wrapper's forward still mid-flight, a crash-before-clear,
 * or just a second client) had its real act suppressed by bookkeeping for a
 * different one. So the mark now carries a one-time nonce, the wrapper sets
 * it on the request it forwards ({@link BREAKGLASS_NONCE_HEADER}), and
 * consumption matches userId AND header: an act the wrapper did not forward
 * cannot spend its mark. The clear-on-failed-forward remains for the mark's
 * own act, and the TTL stays as the backstop that lets a stranded nonce
 * expire; neither is the binding anymore.
 */
const EMERGENCY_MARK_TTL_MS = 60_000;

/**
 * The custom header the break-glass wrapper sets on the request it forwards
 * to better-auth, carrying the mark's nonce. Server-internal: the browser
 * never sends it (the wrapper rebuilds the request), and a leaked value buys
 * nothing — suppressing one's own duplicate audit row is not a privilege.
 */
export const BREAKGLASS_NONCE_HEADER = "x-subshell-breakglass";

interface EmergencyMark {
  /** The nonce only this act's forwarded request carries. */
  nonce: string;
  /** Epoch ms past which the mark is inert (the crash-before-clear backstop). */
  expiresAt: number;
}

/**
 * A per-user LIST, not a per-user slot: two emergency acts for the same admin
 * can be in flight at once (two clients, or a second hatch attempt while the
 * first wrapper's forward is still running), and each act's nonce must live
 * until ITS act consumes it or its own failed forward clears it. A slot made
 * the second mark overwrite the first — the first act's forward then carried
 * a nonce nobody held (audited as an ordinary sign-in, wrong), and the first
 * act's failed clear would disarm the second act's still-live mark (its
 * genuine duplicate then wrote the second row the mark exists to prevent).
 */
const emergencyMarks = new Map<string, EmergencyMark[]>();

/** Drop `userId`'s key when its list drained to empty, else store what remains. */
function storeRemaining(userId: string, remaining: EmergencyMark[]): void {
  if (remaining.length === 0) emergencyMarks.delete(userId);
  else emergencyMarks.set(userId, remaining);
}

/**
 * Called by the break-glass wrapper after it rewrites an admin's credential,
 * binding the (soon-to-be) sign-in to the rewrite row it already audited.
 *
 * @param userId - the admin whose credential was rewritten
 * @returns the nonce the caller must set on {@link BREAKGLASS_NONCE_HEADER}
 *   of the forwarded request — without it, the act's own sign-in will not be
 *   recognized as the rewrite's duplicate and would write a second row
 */
export function markEmergencySignIn(userId: string): string {
  const nonce = randomUUID();
  const mark: EmergencyMark = { nonce, expiresAt: Date.now() + EMERGENCY_MARK_TTL_MS };
  const existing = emergencyMarks.get(userId);
  if (existing) existing.push(mark);
  else emergencyMarks.set(userId, [mark]);
  return nonce;
}

/**
 * Disarm ONE emergency mark — the exact nonce the wrapper minted for the act
 * whose forwarded sign-in came back unsuccessful — so a rewrite that failed
 * to log anyone in cannot suppress anything at all. It removes only THAT
 * nonce: a sibling act for the same user, still mid-flight, keeps its own
 * live mark. Harmless when the mark was already consumed (success path: the
 * hook ate it inline) — removal of an absent nonce is a no-op.
 *
 * @param userId - the admin whose emergency act did not complete
 * @param nonce - the nonce THAT act's wrapper minted, and no other's
 */
export function clearEmergencySignInMark(userId: string, nonce: string): void {
  const marks = emergencyMarks.get(userId);
  if (marks === undefined) return;
  storeRemaining(
    userId,
    marks.filter((mark) => mark.nonce !== nonce),
  );
}

/**
 * True (once) when this successful password sign-in IS one of the marked
 * rewrites: the same user AND that act's own nonce on the request's headers.
 * Exactly the one matching mark is consumed; the user's other in-flight acts
 * keep theirs, and a miss does NOT consume — the act a mark names may still
 * be in flight. Expired entries are tidied on the way past.
 */
function consumeEmergencySignIn(userId: string, headers: Headers | undefined): boolean {
  const marks = emergencyMarks.get(userId);
  if (marks === undefined || marks.length === 0) return false;
  const now = Date.now();
  const live = marks.filter((mark) => mark.expiresAt >= now); // expired anyway — tidy them, answer like no mark
  if (live.length !== marks.length) storeRemaining(userId, live);
  const nonce = headers?.get(BREAKGLASS_NONCE_HEADER) ?? null;
  if (nonce === null) return false;
  const index = live.findIndex((mark) => mark.nonce === nonce);
  if (index === -1) return false;
  storeRemaining(
    userId,
    live.filter((_, i) => i !== index),
  );
  return true;
}

/**
 * The request-bearing slice of the endpoint context better-call hands every
 * hook (before AND after): the dispatch context spreads better-call's router
 * context, which carries the live `Request` at its top level
 * (`dist/router.mjs` `processRequest`); `headers` is the same object rebuilt
 * by `dispatchAuthEndpoint`. Read defensively like everything here — an
 * endpoint invoked without a request (a direct `auth.api.*` call) simply has
 * neither.
 */
export interface AuthHookRequestSlice {
  request?: unknown;
  headers?: unknown;
}

/** The request headers the hook context exposes, whichever field carried them. */
export function hookRequestHeaders(ctx: AuthHookRequestSlice): Headers | undefined {
  if (ctx.request instanceof Request) return ctx.request.headers;
  return ctx.headers instanceof Headers ? ctx.headers : undefined;
}

/**
 * Nonce equality with a length guard before `timingSafeEqual` (which throws
 * on differing lengths) — the same shape `auth-rate-limit.route.ts` uses for
 * the emergency password. The nonce is a server-minted UUID, not a
 * user-chosen secret, so this is hygiene rather than a threat-model
 * requirement; a length mismatch is visible in the timing either way.
 */
function nonceEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * True when `nonce` names a LIVE (unexpired, unconsumed) emergency mark on
 * ANY user — read-only. The door guards (spec §9: "break-glass unchanged")
 * ask this to exempt the wrapper's forwarded sign-in from a closed E-mail
 * door, whose refusal would otherwise land AFTER the rewrite had already
 * destructively reset the admin's credential. It deliberately does NOT
 * consume: {@link consumeEmergencySignIn} stays the only site that spends a
 * mark, so the guard's check cannot starve the audit dedupe that reads the
 * same store moments later on the same request. Expired entries are tidied
 * on the way past, like consume; a forged header names no mark and reads
 * false.
 */
export function hasActiveEmergencyMark(nonce: string | null): boolean {
  if (nonce === null || nonce === "") return false;
  const now = Date.now();
  let found = false; // no early return: every live mark is compared, flat timing
  for (const [userId, marks] of emergencyMarks) {
    const live = marks.filter((mark) => mark.expiresAt >= now);
    if (live.length !== marks.length) storeRemaining(userId, live);
    for (const mark of live) if (nonceEquals(mark.nonce, nonce)) found = true;
  }
  return found;
}

/** The minimal slice of better-auth's after-hook context this module reads. */
interface AuthAfterHookContext extends AuthHookRequestSlice {
  path?: unknown;
  context?: { returned?: unknown };
}

/**
 * Why the exported hook takes `unknown` and casts to the interface above:
 * better-auth types `hooks.after` as better-call's `MiddlewareHandler`, whose
 * declared input type (`MiddlewareInputContext`) does not NAME `path` or
 * `context` at all — while the object dispatch actually hands the after
 * handler carries both (read from `dist/api/dispatch.mjs`, and proven by the
 * green sign-in audit tests firing). So a parameter declared as the real
 * narrow shape fails contravariance against upstream's alias at compile time,
 * and `any` would give up the discipline entirely. `unknown` + the runtime
 * narrowing below is the honest middle: nothing is read unchecked.
 */

/** The minimal slice of a deleted `session` row this module reads. */
interface DeletedSessionRow {
  userId?: unknown;
}

/** The audit sink. Swappable for the failure-resilience test only. */
type AuditWriter = (event: AuditEventInput) => Promise<void>;
let writeAudit: AuditWriter = audit;

/**
 * Points the audit hooks at a different sink. Test-only by construction
 * (the `ForTests` naming convention): the suite injects a throwing writer to
 * prove a failed audit cannot break sign-in, and restores the real one with
 * `null`.
 *
 * @param writer - the sink to use, or `null` to restore the real audit writer
 * @internal
 */
export function setAuditWriterForTests(writer: AuditWriter | null): void {
  writeAudit = writer ?? audit;
}

/**
 * better-auth `hooks.after` handler: audits SUCCESSFUL sign-ins. Never throws
 * (better-auth runs this inline on the response path, so a throw here would
 * fail an authentication that has already succeeded) and never replaces the
 * response. It DOES return `{}` rather than nothing: better-auth 1.7.1 reads
 * `result.headers` off the after hook's return value unconditionally
 * (`dist/api/dispatch.mjs` runAfterHooks), so an `undefined` return crashes
 * the very request being audited. Empty object = no response, no headers.
 *
 * @param rawCtx - the endpoint context better-auth hands the after handler;
 *   narrowed to the interface above inside (see the note there)
 */
export async function auditAuthAfterRequest(rawCtx: unknown): Promise<object> {
  try {
    const ctx = (rawCtx ?? {}) as AuthAfterHookContext;
    const method = typeof ctx.path === "string" ? SIGN_IN_ENDPOINT_METHODS[ctx.path] : undefined;
    if (!method) return {};
    // On success better-auth leaves the endpoint's JSON payload in
    // `context.returned`; on failure it leaves the APIError there instead. The
    // payloads that count (both sign-in endpoints) carry `user.id`, an error
    // carries no `user` — so reading the id IS the success test. `token`
    // lives in the same payload and must never be touched.
    const user = (ctx.context?.returned as { user?: { id?: unknown } } | undefined)?.user;
    const userId = typeof user?.id === "string" ? user.id : "";
    if (!userId) return {};
    if (method === "password" && consumeEmergencySignIn(userId, hookRequestHeaders(ctx))) return {};
    await writeAudit({
      actorUserId: userId,
      action: "auth.sign_in",
      targetType: "user",
      targetId: userId,
      metadataJson: JSON.stringify({ method }),
    });
  } catch (err) {
    // Belt-and-suspenders: `audit` already swallows its own failures; this
    // catches anything between the hook entry and that call, so the auth
    // path cannot fail on its bookkeeping.
    logger.warn(`audit: auth.sign_in hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {};
}

/**
 * better-auth `databaseHooks.session.delete.after` handler: audits a
 * sign-out once per session row actually deleted (sign-out, session
 * revocation, and the self-service password change that revokes sessions all
 * end in this delete; admin-side revocations delete through raw SQL and stay
 * under their own `user.password_reset` / `user.disabled_change` rows, so no
 * act is recorded twice). Never throws — a failed audit must not fail the
 * sign-out it is recording.
 *
 * @param session - the deleted session row; only `userId` is read
 */
export async function auditSessionDeleted(session: DeletedSessionRow): Promise<void> {
  try {
    const userId = typeof session?.userId === "string" ? session.userId : "";
    if (!userId) return;
    await writeAudit({
      actorUserId: userId,
      action: "auth.sign_out",
      targetType: "user",
      targetId: userId,
      // No metadata: the delete seam cannot name HOW the signed-in user got
      // here, and inventing a field would be a guess. The row says who lost a
      // session and when, which is the whole question this answers.
      metadataJson: null,
    });
  } catch (err) {
    logger.warn(`audit: auth.sign_out hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Drops the pending emergency-login marks. Only for tests (the map is
 * process-global and the suite DB is shared).
 * @internal
 */
export function resetEmergencySignInMarksForTests(): void {
  emergencyMarks.clear();
}
