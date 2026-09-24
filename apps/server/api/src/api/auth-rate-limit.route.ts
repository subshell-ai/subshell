import { timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { BREAKGLASS_NONCE_HEADER, clearEmergencySignInMark, markEmergencySignIn } from "@/auth/audit-hooks.js";
import { getAuth } from "@/auth.js";
import { emergencyLoginArmed, emergencyPassword } from "@/constants.js";
import { db } from "@/db/index.js";
import { audit } from "@/services/audit.js";
import { logger } from "@/utils/logger.js";

/**
 * Hard cap on the sign-in delay (2^n seconds per recorded failure, at most
 * 30s). Kept as a named constant so tests can assert the cap without
 * duplicating the magic number.
 */
export const maxAuthBackoffMs = 30_000;

/** 0 recorded failures -> no delay; else 2^n seconds, capped at maxAuthBackoffMs. */
export function authDelayForAttempts(attemptCount: number | undefined): number {
  if (!attemptCount) return 0;
  return Math.min(maxAuthBackoffMs, 2 ** attemptCount * 1000);
}

/** Emails are attributed lowercase with surrounding whitespace trimmed. */
export function normalizeAuthEmail(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Constant-time string equality so the env-value comparison cannot be read
 * as a timing oracle for the break-glass password. A length mismatch is
 * (necessarily) visible in the timing; `timingSafeEqual` itself throws on
 * differing lengths, so the length guard comes first.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Delay currently owed by an email, based on its recorded failure count. */
async function authDelayMs(email: string): Promise<number> {
  const row = await db.selectFrom("authAttempts").select("attemptCount").where("email", "=", email).executeTakeFirst();
  return authDelayForAttempts(row?.attemptCount);
}

/** Records one more failed sign-in for an email (upsert, monotonic count). */
async function recordFailedLogin(email: string): Promise<void> {
  if (!email) return; // no email -> nothing to attribute (matches authDelayMs)
  await db
    .insertInto("authAttempts")
    .values({
      email,
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column("email").doUpdateSet({
        attemptCount: sql`auth_attempts.attempt_count + 1`,
        lastAttemptAt: new Date().toISOString(),
      }),
    )
    .execute();
}

/** A successful sign-in resets the failure count for an email. */
async function clearAuthAttempts(email: string): Promise<void> {
  if (!email) return;
  await db.deleteFrom("authAttempts").where("email", "=", email).execute();
}

/** The sign-in request body (success case), for the forwarding request. */
type SignInBody = { email?: string; password?: string };

/**
 * Wraps better-auth's email sign-in with an exponential backoff delay.
 *
 * Mounted before better-auth's own `/api/auth/*` passthrough so this route
 * wins the match for `POST /api/auth/sign-in/email`. Each failed attempt
 * (401) bumps a per-email counter; the next attempt waits 2^n seconds
 * (capped at 30s); a successful sign-in clears the counter.
 *
 * The incoming request body must be read here (for the email) and the
 * request rebuilt before forwarding: better-auth's router clones the request
 * (its `cloneRequest` option) and `Request.clone()` throws once a body has
 * been consumed, so passing the consumed request through would fail.
 */
/**
 * Break-glass admin login (spec 2026-08-31 §6): when SUBSHELL_EMERGENCY_PASSWORD
 * is set and the submitted password equals it EXACTLY for an existing account
 * whose user_meta role is "admin", overwrite that account's credential hash
 * with the env value's hash. The caller then forwards the ordinary sign-in:
 * better-auth verifies the value just stored and mints a REAL session
 * through its own path — nothing is forged.
 *
 * The overwrite is destructive by design (the forgotten password dies the
 * moment the hatch fires); the armed-state banner tells the admin to set a
 * new password before clearing the env var. Non-admin/mismatch/unknown-email
 * answer `null` without touching anything, so the response stays an ordinary
 * bad-password 401 — no signal about which half failed. Every APPROVED
 * rewrite is an audit event + a warn log line: it is the single most
 * sensitive auth event the instance can produce and must leave a trace.
 *
 * Raw SQL on purpose: better-auth owns `user`/`account`/`user_meta` targets
 * (camelCase columns outside the typed Database) — same precedent as
 * UsersRepository.createUser.
 *
 * @param lookupEmail - the submitted email LOWERCASED ONLY (no trim), which
 *   is exactly what better-auth looks up (sign-in.mjs:317; padded emails are
 *   format-rejected with 400 at sign-in.mjs:316 before any lookup, so the
 *   hatch must not rewrite for them either — trimming here once destroyed a
 *   password while granting no session)
 * @param password - the submitted password, compared to the env value
 * @returns the rewritten admin's id AND the dedupe mark's nonce when the
 *   emergency act fired, or `null`. The id lets the caller disarm the mark
 *   if its forward does not complete; the nonce must ride the forwarded
 *   request on {@link BREAKGLASS_NONCE_HEADER}, because the mark is bound to
 *   this act — no header, no suppression (see below)
 */
async function rewriteAdminCredentialToEnvPassword(
  lookupEmail: string,
  password: string,
): Promise<{ userId: string; nonce: string } | null> {
  const envValue = emergencyPassword();
  if (!emergencyLoginArmed() || !lookupEmail || !secretEquals(password, envValue)) return null;
  const found = await sql<{ id: string; role: string | null }>`
    SELECT u.id, m.role
    FROM user u
    LEFT JOIN user_meta m ON m.user_id = u.id
    WHERE u.email = ${lookupEmail}
  `.execute(db);
  const row = found.rows[0];
  if (row?.role !== "admin") return null;
  await sql`
    UPDATE account
    SET password = ${await hashPassword(envValue)}, "updatedAt" = ${new Date().toISOString()}
    WHERE userId = ${row.id} AND providerId = 'credential'
  `.execute(db);
  await audit({
    actorUserId: row.id,
    action: "emergency_login.rewrite_credential",
    targetType: "user",
    targetId: row.id,
    metadataJson: JSON.stringify({ email: lookupEmail }),
  });
  // One act, one row (audit item R1): the `hooks.after` sign-in audit consumes
  // this mark instead of writing a second row for the forwarded sign-in that
  // follows. The rewrite row — which names the credential change, the act
  // that actually matters — wins the name. The mark binds to THIS act through
  // the nonce the caller must put on the forwarded request's
  // `x-subshell-breakglass` header: a genuine sign-in that merely happens to
  // interleave with an armed mark is not this act and cannot consume it. If
  // the forward below fails, nothing carried the nonce to a success, and the
  // caller disarms the mark so its nonce can never suppress anything.
  const nonce = markEmergencySignIn(row.id);
  logger.warn(
    `emergency login: admin credential for ${lookupEmail} rewritten to the SUBSHELL_EMERGENCY_PASSWORD value`,
  );
  return { userId: row.id, nonce };
}

export const authRateLimitRoutes = new Elysia({ name: "auth-rate-limit" }).post(
  "/api/auth/sign-in/email",
  async ({ request }) => {
    const body = (await request.json().catch(() => null)) as SignInBody | null;
    // The wrapper only speaks JSON (the app's login form is JSON); anything
    // else returns 400 without forwarding, so better-auth can't be confused.
    if (!body) {
      return new Response(JSON.stringify({ message: "Invalid sign-in body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const email = normalizeAuthEmail(body?.email);
    const delay = await authDelayMs(email);
    if (delay) await Bun.sleep(delay);

    // Hatch attempts share the ordinary backoff: the delay above already
    // applied to them. A rewrite here is invisible to the client — the
    // forwarded body is unchanged (password === env value) and better-auth's
    // success path (cookie + attempt-clear below) does the rest. The lookup
    // email is lowercased but deliberately NOT trimmed (see the function's
    // @param) even though backoff attribution above does trim.
    const emergency = await rewriteAdminCredentialToEnvPassword((body.email ?? "").toLowerCase(), body.password ?? "");

    // The rebuild is where the act's binding travels: the nonce rides the
    // forwarded request so the after-hook can tell THIS sign-in — the
    // rewrite's own duplicate — from a genuine one that merely shares the
    // user and the moment. A browser cannot send it (this wrapper owns the
    // only copy), and it never leaves the process.
    const headers = new Headers(request.headers);
    if (emergency) headers.set(BREAKGLASS_NONCE_HEADER, emergency.nonce);
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      // Optional third-party semantics survive the rebuild (default: same-origin).
      credentials: request.credentials,
      signal: request.signal,
    });
    const res = await getAuth().handler(forwarded);

    if (res.status === 401) {
      await recordFailedLogin(email);
    } else if (res.ok && email) {
      await clearAuthAttempts(email);
    }
    // The emergency dedupe mark covers exactly the sign-in this forward IS.
    // On success the after-hook spent it inline before this line (it read the
    // nonce right off this request); on a failed forward nothing that
    // succeeded carried it, and a stranded mark is one the clear below removes
    // rather than a TTL's patience. The rewrite row already stands as that
    // act's audit; any other act, whenever it comes, deserves its own.
    if (emergency && !res.ok) {
      clearEmergencySignInMark(emergency.userId, emergency.nonce);
    }
    return res;
  },
);
