import type { Session, User } from "better-auth";
import { Elysia, t } from "elysia";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";

/** How the request authenticated — drives permission and admin policy. */
export type GuardActor = "cookie" | "system-key" | "subshell-key";

/** The api-key row subset the guard reads off a successful verification. */
interface VerifiedKeyRow {
  id: string;
  referenceId: string | null;
  /**
   * The plugin always hands back a parsed object (it runs stored strings
   * through its own metadata migration before returning the row).
   */
  metadata: Record<string, unknown> | null;
  permissions: Record<string, string[]> | null;
}

/**
 * Verifies a bearer API key and maps it to the guard's context fields.
 *
 * Subshell tokens (metadata.kind === "subshell") resolve to the `sess:<id>`
 * principal and carry their permissions for {@link requirePerm}; the synthetic
 * `user` is the subshell's OWNER so existing owner-scoped routes keep working.
 * A subshell token whose subshell row is gone is 401 even if the key itself is
 * valid — the row is the lifecycle truth. System keys authenticate as their
 * owning user with no permission ceiling (plan decision: admins manage them).
 * Node-kind keys are rejected outright here — they are `/ws/node` credentials
 * only (spec 2026-08-31 §5.5).
 */
async function deriveFromApiKey(bearer: string) {
  let valid = false;
  let row: VerifiedKeyRow | undefined;
  try {
    const res = (await auth.api.verifyApiKey({ body: { key: bearer } })) as unknown as {
      valid: boolean;
      key?: VerifiedKeyRow;
    };
    valid = res.valid;
    row = res.key;
  } catch {
    valid = false;
  }
  if (!valid || !row) throw new UnauthorizedError();

  const meta = row.metadata;
  if (meta?.kind === "subshell" && typeof meta.subshellId === "string") {
    const subshellRow = await new SubshellsRepository(db).findById(meta.subshellId);
    // The subshell's apiKeyId column is written ONLY by the server-side
    // issueSubshellToken, so `apiKeyId === row.id` proves this key is the one
    // we minted for that subshell — not a self-forged key (the plugin's public
    // create endpoint lets any signed-in user attach arbitrary metadata).
    // The row is additionally the lifecycle truth: a gone subshell 401s even
    // while its key still verifies.
    if (!subshellRow || subshellRow.apiKeyId !== row.id) throw new UnauthorizedError();
    return {
      user: { id: subshellRow.userId } as User,
      session: undefined,
      principal: `sess:${subshellRow.id}`,
      actor: "subshell-key" as const,
      apiKeyId: row.id,
      apiKeyPermissions: row.permissions ?? {},
    };
  }
  if (meta?.kind === "node") {
    // Explicit, permanent rejection (spec 2026-08-31 §5.5): a node key's blast
    // radius is exactly "open /ws/node as that node". Do NOT widen this.
    throw new UnauthorizedError("Node keys cannot be used on the REST API");
  }
  // System-key actor is reserved for keys owned by the `system` service user
  // (minted through admin-only routes); anything else reaching here is a
  // self-minted key with no subshell metadata — not a credential we issue.
  if (!row.referenceId || row.referenceId !== (await ensureSystemUser())) throw new UnauthorizedError();
  return {
    user: { id: row.referenceId } as User,
    session: undefined,
    principal: `user:${row.referenceId}`,
    actor: "system-key" as const,
    apiKeyId: row.id,
    apiKeyPermissions: null,
  };
}

/**
 * True when `bearer` is a credential THIS instance issues — exactly the
 * accept-set of {@link deriveFromApiKey} (and therefore of {@link authGuard}):
 * a subshell-kind key linked to its subshell row's `apiKeyId`, or a key owned
 * by the `system` user. Conditionally-authenticated routes (the setup harness
 * endpoints, which must stay public during the first-run window) classify
 * bearer keys through this instead of re-deriving a weaker check, so a key
 * the guard 401s can never 200 anywhere else (security audit 2026-08, final
 * review M-1). Non-401 failures (store errors) propagate like they do in the
 * guard.
 */
export async function isIssuedCredential(bearer: string): Promise<boolean> {
  try {
    await deriveFromApiKey(bearer);
    return true;
  } catch (err) {
    if (err instanceof UnauthorizedError) return false;
    throw err;
  }
}

/**
 * Requires an authenticated principal for all routes under /api (except the
 * auth + setup endpoints). Two credential kinds:
 *
 * 1. better-auth session cookie (browser) — unchanged behavior.
 * 2. `Authorization: Bearer <api-key>` (MCP clients / scripts) — verified via
 *    the @better-auth/api-key plugin; see {@link deriveFromApiKey}.
 *
 * Injects { user, principal, actor, apiKeyId, apiKeyPermissions } into route
 * context. `session` exists only on the cookie path.
 */
export const authGuard = new Elysia({ name: "auth-guard" })
  // The handler throws UnauthorizedError when not authenticated; Elysia turns
  // it into a 401. Route context then always has { user, ... }.
  .derive({ as: "scoped" }, async ({ request }) => {
    const cookieHeader = request.headers.get("cookie") ?? "";
    // A session cookie that is present but invalid 401s outright — the
    // bearer path is never tried underneath it (credential precedence the
    // security audit pinned).
    if (extractSessionToken(cookieHeader)) {
      const result = await resolveCookieSession(cookieHeader);
      if (!result) throw new UnauthorizedError();
      return {
        user: result.user as User,
        session: result.session as Session,
        principal: `user:${result.user.id}`,
        actor: "cookie" as const,
        apiKeyId: null,
        apiKeyPermissions: null,
      };
    }
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) throw new UnauthorizedError();
    return deriveFromApiKey(bearer);
  })
  .as("scoped");

/** The context subset {@link requirePerm} needs (route ctx satisfies it). */
export interface PermContext {
  /** How the request authenticated. */
  actor: GuardActor;
  /** The subshell key's grants; null/undefined = unrestricted. */
  apiKeyPermissions: Record<string, string[]> | null;
}

/**
 * Throws 403 unless the caller may `action` on `resource`.
 *
 * Cookie and system-key actors pass unconditionally; subshell tokens are
 * checked against their key's `permissions` map (e.g. `{channels:["read"]}`
 * fails `requirePerm(ctx, "channels", "write")`). Call it at the top of a
 * handler — it is cheap and synchronous.
 */
export function requirePerm(ctx: PermContext, resource: "channels" | "subshells", action: "read" | "write"): void {
  if (ctx.actor !== "subshell-key") return;
  if (!(ctx.apiKeyPermissions?.[resource] ?? []).includes(action)) throw new ForbiddenError();
}

/**
 * Thrown by guards on missing/invalid credentials; Elysia maps `status`.
 * The message is overridable (it reaches the client via the error handler);
 * the default keeps every generic rejection worded as it always has been.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown by guards on insufficient permissions; Elysia maps `status`. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

/**
 * Route-level error carrying an HTTP status; Elysia maps `status` to the
 * response code. The shared form for "throw NNN with this message" in any
 * /api route handler — routes need not redeclare it per file.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Cookie-only gate: surfaces whose action is a human-in-the-browser/device
 * act — enabling browser push, enrolling a phone — reject machine
 * credentials outright. Extracted from `notifications.route.ts` so the
 * devices route mirrors it instead of forking the 403 shape.
 * @param actor - The request's authenticated actor kind
 * @param message - The full 403 message the surface wants on the wire
 * @throws HttpError 403 when the actor is not a browser session cookie
 */
export function requireCookieActor(actor: GuardActor, message: string): void {
  if (actor !== "cookie") throw new HttpError(403, message);
}

/**
 * Admin-only guard, a drop-in replacement for `authGuard` on admin routes:
 *
 *   .use(requireAdmin)   // instead of .use(authGuard)
 *
 * Composes the subshell guard internally and additionally resolves the acting
 * user's role from the app's `user_meta` table, throwing a 403 for non-admins
 * (ForbiddenError carries `status = 403`, which Elysia maps to the response
 * code). Requires the subshell first: an expired/anonymous request gets a 401,
 * a known non-admin gets a 403. Injects { role } into context so handlers
 * can read the resolved role.
 *
 * Admin operations additionally require the COOKIE path: API keys (system or
 * subshell) are machine credentials and cannot manage the instance (403) —
 * plan decision, spec §8.
 */
export const requireAdmin = new Elysia({ name: "require-admin" })
  .use(authGuard)
  .derive({ as: "scoped" }, async ({ user, actor }) => {
    // authGuard throws 401 before this derive when the subshell is missing,
    // so user is always present; the check keeps the type honest
    // (scoped plugins surface their derived values as optional here).
    if (!user) throw new UnauthorizedError();
    if (actor !== "cookie") throw new ForbiddenError();
    const role = await new UserMetaRepository(db).getRole(user.id);
    if (role !== "admin") throw new ForbiddenError();
    return { role } as const;
  })
  .as("scoped");

/** Optional subshell-name schema reused by subshell creation. */
export const SubshellNameSchema = t.Optional(t.String({ minLength: 1, maxLength: 120 }));
