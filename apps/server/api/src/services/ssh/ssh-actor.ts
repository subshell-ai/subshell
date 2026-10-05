import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import type { GuardActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { originRegistry } from "@/services/trusted-origins.js";

/**
 * The caller-side plumbing every `/api/ssh` route shares: the plain-data
 * {@link SshCaller} the policy reads, the coarse `ssh` permission check, and
 * the explicit origin validation SSH-SUPPORT.md §2 demands of every
 * cookie-session WRITE ("Validate request origin/CSRF on these writes
 * explicitly; do not assume cookie authentication alone is sufficient").
 */

/** The guard-derived request fields {@link buildSshCaller} consumes. */
export interface SshGuardFacts {
  actor: GuardActor;
  user: { id: string };
  principal?: string | null;
  apiKeyId?: string | null;
}

/**
 * Resolves the guard's context into the policy's plain-data caller.
 * `isAdmin` is the ONE read this helper adds (the guard resolves role only on
 * `requireAdmin` surfaces; the SSH policy needs it to answer the `local`-node
 * admin arm, and admin status is never an override - §2 says so twice).
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

/** The context subset {@link requireSshPerm} reads (route ctx satisfies it). */
export interface SshPermContext {
  actor: GuardActor;
  apiKeyPermissions: Record<string, string[]> | null;
}

/**
 * The coarse `ssh` token permission (SSH-SUPPORT.md §2: "Explicit SSH token
 * permission plus a human-issued per-pane, per-connection grant; NO legacy
 * permission fallback"). This mirrors `requirePerm`'s posture - cookie and
 * system actors pass the SCOPE check (the policy still refuses every machine
 * credential where the spec says machine credentials cannot act) - and a
 * subshell key needs `ssh` in its permissions map with the action it asks.
 *
 * Deliberately local until the coordinator widens `requirePerm`'s resource
 * union with the `ssh` member and adds `ssh: ["read", "write"]` to
 * `issueSubshellToken`'s mint map (both hunks are in the task-D report; the
 * pre-feature map carries no `ssh` key, which is exactly the refusal this
 * helper must produce for old tokens - absence denies, no grandfathering).
 */
export function requireSshPerm(ctx: SshPermContext, action: "read" | "write"): void {
  if (ctx.actor !== "subshell-key") return;
  if (!(ctx.apiKeyPermissions?.ssh ?? []).includes(action)) throw new SshForbiddenError();
}

/** 403 for a coarse-permission refusal (mapped like `ForbiddenError` by status). */
export class SshForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "SshForbiddenError";
  }
}

/**
 * Explicit origin validation for cookie-session SSH WRITES (spec §2; the
 * plan's "new ground" item - the house precedent for the human door is
 * `requireCookieActor`, and no existing surface validates Origin itself).
 *
 * Rules, in order, each refusing less than the last would:
 * - Non-cookie actors never reach this check: a bearer credential has no
 *   ambient authority to forge a cross-site request with (its key IS the
 *   request), and the policy answers those acts anyway. No-op here.
 * - No `Origin` header at all → allowed. That is curl/scripts and the
 *   same-origin `fetch` some browsers omit for GETs; the WRITE routes
 *   already required a cookie, and SameSite=Lax (the cookie's floor) still
 *   never attaches one to a cross-site POST.
 * - `Origin` present → it must be a member of the LIVE origin registry
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
