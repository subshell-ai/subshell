import { APIError } from "better-auth/api";
import type { Kysely } from "kysely";
import { BREAKGLASS_NONCE_HEADER, hasActiveEmergencyMark, hookRequestHeaders } from "@/auth/audit-hooks.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * The E-mail provider guard (spec 2026-09-24 §7).
 *
 * WHY this layer exists beside `user.validateUserInfo`, stated because the
 * division of labor was MEASURED, not guessed (better-auth 1.7.1,
 * `dist/api/routes/sign-in.mjs` has no `assertValidUserInfo` call; the util's
 * only importers are the internal adapter's `createUser`,
 * `oauth2/link-account.mjs` and `api/routes/callback.mjs`):
 * `validateUserInfo` fires for email-password CREATE and for the three OAuth
 * provisioning seams — and NEVER for `/sign-in/email` or
 * `/passkey/verify-authentication`. So a closed E-mail provider's SIGN-IN
 * refusal has no other server-side layer: password auth's action set simply
 * does not run the provisioning hook. Both layers, one row, no measurement
 * gamble — `validateUserInfo` carries provisioning, this hook carries the
 * two credential-verification paths, and `session.create.before` stays the
 * last backstop (disabled/pending), not this provider's answer.
 *
 * The refusal is a THROWN `APIError(403)` — the 1.7.1 `hooks.before` shape:
 * dispatch runs the handler inline and lets an APIError propagate to the
 * endpoint error path (`dist/api/dispatch.mjs`), which is how it reaches the
 * browser as a structured 403 through both the HTTP router and `auth.api.*`.
 * Everything not matched returns nothing, which runBeforeHooks treats as
 * "context unmodified".
 *
 * Reading the row through `AuthProvidersRepository` (async, the app handle)
 * rather than `loadProviderRowsSync`: that loader's WHERE filters a disabled
 * provider OUT of its result, and "filtered out" is exactly what this hook must
 * distinguish from "explicitly closed" — it reads the one row by primary key
 * and answers to EITHER explicit close: `enabled = 0` (the master switch,
 * writable by the PATCH route and shown as the Enabled toggle on the table's
 * email row — final review, Important 1) or `sign_in_enabled = 0`. Every
 * other reader (the last-provider count, the anonymous `emailSignIn`, the provider
 * policy) already treats `enabled = 0` as closed; §7's "a hidden provider is not
 * a closed one" is false unless the SIGN-IN path reads the same flag. An
 * ABSENT row (a database predating migration 0037 — no server boots in that
 * state, but the read is defensive) is not an explicit close and passes.
 *
 * Break-glass is EXEMPT (spec §9 "break-glass unchanged"): the emergency
 * wrapper destructively rewrites the admin's credential BEFORE the forwarded
 * sign-in reaches this hook, so a closed provider refusing that forward would
 * lock the operator out of the account it just took the password of. The
 * exemption is a live server-held nonce on the forwarded request's
 * {@link BREAKGLASS_NONCE_HEADER} — set by the wrapper only when the rewrite
 * fired, minted in-memory and never visible to a client. A forged header
 * names no mark, fails {@link hasActiveEmergencyMark}, and still hits the
 * guard.
 */
const GUARDED_PATHS: readonly string[] = ["/sign-in/email", "/passkey/verify-authentication"];

/**
 * Builds the `hooks.before` handler. The factory exists because the hook
 * must read the app database LAZILY through the injected handle
 * (`auth.ts`'s `setAuthPolicyDb` seam): wiring it as a plain function would
 * either import the database at module evaluation (the import-purity
 * invariant `auth-import-purity.test.ts` pins) or snapshot a handle that is
 * not open yet. `getDb` returning `undefined` is the pre-boot gap — the same
 * answer every other policy read gives there (allow), and unreachable on a
 * listening server because boot injects before it listens.
 */
export function createProviderGuardBeforeHook(
  getDb: () => Kysely<Database> | undefined,
): (rawCtx: unknown) => Promise<void> {
  return async (rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as { path?: unknown; request?: unknown; headers?: unknown } | null | undefined;
    const path = ctx?.path;
    if (typeof path !== "string" || !GUARDED_PATHS.includes(path)) return;
    const nonce = hookRequestHeaders(ctx ?? {})?.get(BREAKGLASS_NONCE_HEADER) ?? null;
    if (hasActiveEmergencyMark(nonce)) return;
    const db = getDb();
    if (!db) return;
    const row = await new AuthProvidersRepository(db).getById("email");
    if (row && (row.enabled === 0 || row.signInEnabled === 0)) {
      throw new APIError(403, { message: "Password and passkey sign-in are disabled on this instance" });
    }
  };
}
