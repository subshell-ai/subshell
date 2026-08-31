import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { auth } from "@/auth.js";
import { emergencyPassword } from "@/constants.js";
import { db } from "@/db/index.js";

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
 * Break-glass admin login (spec 2026-08-31 §6): when MOTE_EMERGENCY_PASSWORD
 * is set and the submitted password equals it EXACTLY for an existing account
 * whose user_meta role is "admin", overwrite that account's credential hash
 * with the env value's hash. The caller then forwards the ordinary sign-in:
 * better-auth verifies the value just stored and mints a REAL session
 * through its own path — nothing is forged.
 *
 * The overwrite is destructive by design (the forgotten password dies the
 * moment the hatch fires); the armed-state banner tells the admin to set a
 * new password before clearing the env var. Non-admin/mismatch/unknown-email
 * return false without touching anything, so the response stays an ordinary
 * bad-password 401 — no signal about which half failed.
 *
 * Raw SQL on purpose: better-auth owns `user`/`account`/`user_meta` targets
 * (camelCase columns outside the typed Database) — same precedent as
 * UsersRepository.createUser.
 *
 * @param email - normalized (lowercased, trimmed) sign-in email
 * @param password - the submitted password, compared to the env value
 * @returns true when the credential was rewritten (emergency login approved)
 */
async function rewriteAdminCredentialToEnvPassword(email: string, password: string): Promise<boolean> {
  const envValue = emergencyPassword();
  if (!envValue || !email || password !== envValue) return false;
  const found = await sql<{ id: string; role: string | null }>`
    SELECT u.id, m.role
    FROM user u
    LEFT JOIN user_meta m ON m.user_id = u.id
    WHERE u.email = ${email}
  `.execute(db);
  const row = found.rows[0];
  if (row?.role !== "admin") return false;
  await sql`
    UPDATE account
    SET password = ${await hashPassword(envValue)}, "updatedAt" = ${new Date().toISOString()}
    WHERE userId = ${row.id} AND providerId = 'credential'
  `.execute(db);
  return true;
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
    // success path (cookie + attempt-clear below) does the rest.
    await rewriteAdminCredentialToEnvPassword(email, body.password ?? "");

    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(body),
      // Optional third-party semantics survive the rebuild (default: same-origin).
      credentials: request.credentials,
      signal: request.signal,
    });
    const res = await auth.handler(forwarded);

    if (res.status === 401) {
      await recordFailedLogin(email);
    } else if (res.ok && email) {
      await clearAuthAttempts(email);
    }
    return res;
  },
);
