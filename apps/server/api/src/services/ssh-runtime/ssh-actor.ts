import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import type { GuardActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { originRegistry } from "@/services/trusted-origins.js";

/**
 * The caller-side plumbing the `/api/ssh-runtime` node verbs share
 * (re-homed from the retired `services/ssh/ssh-actor.ts` by Workstream C's
 * retirement, design 2026-10-05 §7: the old doors retire, the live seams
 * move). The plain-data {@link SshCaller} the gates read, and the explicit
 * origin validation every cookie-session SSH WRITE carries.
 *
 * What did NOT move: the coarse `ssh` token permission (that scope retired
 * with the product; these verbs are human-only and refuse machine
 * credentials outright) and the grant/pane decision types.
 */

/**
 * A caller's resolved identity as the guard saw it, in plain data so the
 * gates never re-read the request. `userId` follows the guard's resolution
 * (a subshell key resolves to its OWNER); owner identity is necessary and
 * NOT sufficient here - this surface admits cookie actors only, and the
 * fields stay because the eligibility arms read them exactly as the retired
 * policy's did (auth semantics are unchanged by the move).
 */
export interface SshCaller {
  /** Credential kind as auth-guard derived it (node keys never reach REST). */
  actor: GuardActor;
  /** The resolved user id behind the credential. */
  userId: string;
  /** `sess:<id>` principal for a subshell key; null for cookie and system-key actors. */
  principal: string | null;
  /** The presenting api-key's id for bearer actors; null for cookie. */
  apiKeyId: string | null;
  /** The subshell a subshell-key is bound to; null otherwise. */
  subshellId: string | null;
  /** Admin flag from the guard (never an override: it only answers the built-in `local` node's admin arm). */
  isAdmin: boolean;
}

/** The guard-derived request fields {@link buildSshCaller} consumes. */
export interface SshGuardFacts {
  actor: GuardActor;
  user: { id: string };
  principal?: string | null;
  apiKeyId?: string | null;
}

/**
 * Resolves the guard's context into the gate's plain-data caller.
 * `isAdmin` is the ONE read this helper adds - needed only to answer the
 * built-in `local` node's admin arm; admin status is never an override on
 * an enrolled machine.
 */
export async function buildSshCaller(guard: SshGuardFacts): Promise<SshCaller> {
  const principal = guard.principal ?? null;
  return {
    actor: guard.actor,
    userId: guard.user.id,
    principal,
    apiKeyId: guard.apiKeyId ?? null,
    subshellId:
      guard.actor === "subshell-key" && principal !== null && principal.startsWith("sess:")
        ? principal.slice("sess:".length)
        : null,
    isAdmin: guard.actor === "cookie" ? (await new UserMetaRepository(db).getRole(guard.user.id)) === "admin" : false,
  };
}

/**
 * Explicit origin validation for cookie-session SSH WRITES (the retired
 * spec's "new ground" item, kept verbatim: the house precedent for the
 * human door is `requireCookieActor`, and no existing surface validates
 * Origin itself).
 *
 * Rules, in order, each refusing less than the last would:
 * - Non-cookie actors never reach this check: a bearer credential has no
 *   ambient authority to forge a cross-site request with (its key IS the
 *   request). No-op here.
 * - No `Origin` header at all -> allowed. That is curl/scripts and the
 *   same-origin `fetch` some browsers omit; the WRITE routes already
 *   required a cookie, and SameSite=Lax (the cookie's floor) still never
 *   attaches one to a cross-site POST.
 * - `Origin` present -> it must be a member of the LIVE origin registry
 *   (`originRegistry()`, the four-derived-source allowlist CORS itself uses),
 *   which by construction includes this instance's own origins. A cross-site
 *   attacker's origin is not, and the DNS-rebinding rule is preserved: the
 *   registry is derived from configuration, never from the request's Host.
 */
export function assertCookieWriteOrigin(actor: GuardActor, request: Request): void {
  if (actor !== "cookie") return;
  const origin = request.headers.get("origin");
  if (origin === null) return;
  if (!originRegistry().has(origin)) {
    throwApiError({
      code: BackendErrorCodes.ACCESS_DENIED,
      message: "This write must come from a trusted origin (the instance's own address or a configured one)",
      doNotLog: true,
    });
  }
}
