import { BackendErrorCodes } from "@internal/backend-errors";
import { builtInHarnesses, builtInIds } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
import { ForbiddenError, isIssuedCredential, UnauthorizedError } from "@/api/auth-guard.js";
import { harnessInfo } from "@/api/harness-utils.js";
import { HarnessInfoSchema } from "@/api/models.js";
import { IS_TEST } from "@/constants.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import { installLocalPlugin, localPluginReports, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { hasAnyUser } from "@/services/registration-gate.js";

const SetupStatusSchema = t.Object({
  // These descriptions reach OpenAPI and the generated SDK on the instance's
  // one always-public route, so they are read outside this repo: say what the
  // counter actually counts. The `system` service account is not an account
  // anybody can sign in as, and it exists from a server's very first boot.
  needsSetup: t.Boolean({
    description: "True until the first account is registered (the service account does not count)",
  }),
  hasUsers: t.Boolean({ description: "Whether any account exists other than the internal service account" }),
});

/**
 * The plugin ids installed on this INSTANCE, read from the instance store —
 * which since Task 9 IS the record (there is no per-node mirror to consult).
 *
 * Was the `harness_plugins` enable table until phase 2b, and the wizard's
 * question changed with it: not "which of these do you want on" but "which of
 * these do you want installed". A BROKEN plugin is NOT counted installed
 * here — the same filter the mirrored read applied before this move, so a
 * plugin that will not load reads as not-installed to every consumer of
 * `installedHere` (the preset editor filters its picker on exactly that).
 * The admin's instance page is the surface that shows the broken row and its
 * reason: `GET /api/plugins` iterates the disk reports, `broken` included.
 */
async function installedIdsHere(): Promise<Set<string>> {
  return new Set((await localPluginReports()).filter((r) => !r.broken).map((r) => r.id));
}

/**
 * Test seam for the needsSetup window (the per-process temp-file test DB is
 * one database shared by every test file in the run, and they write users
 * into it, so no suite may observe or force it empty). Passing `null`
 * restores the real probe. The seam forces the setup endpoints public when
 * told to, so it hard-refuses to run outside the test suite (final review
 * M-5) — one mis-wired prod import must not be able to unauthenticate the
 * harness registry.
 * @internal
 */
export function setHasUsersProbeForTests(fn: (() => Promise<boolean>) | null): void {
  if (!IS_TEST) throw new Error("setHasUsersProbeForTests is a test-only seam");
  hasUsersProbe = fn ?? realHasUsers;
}

async function realHasUsers(): Promise<boolean> {
  // `hasAnyUser` is the ONE counter — the registration gate and the boot
  // handoff line ask it too, so the wizard's gate, the door it opens and the
  // line telling an operator to go there cannot answer differently. It counts
  // real ACCOUNTS rather than `user_meta` rows, which is what keeps this
  // public window from reopening on an instance whose role side-table lost a
  // row (see the repository's docstring).
  return await hasAnyUser(db);
}

let hasUsersProbe: () => Promise<boolean> = realHasUsers;

/**
 * Classify a request's credential the way `authGuard` does, minimally:
 * "cookie" (live better-auth session), "machine" (a bearer key the guard
 * itself would accept — see `isIssuedCredential`; raw `verifyApiKey` is
 * WEAKER than the guard and was finding M-1), or throw 401. A valid session
 * token outranks a bearer header and duplicate cookies select first-match,
 * both same as the guard — and the cookie extraction is literally the
 * guard's helper, so the https `__Secure-` spelling can never diverge here
 * again. Kept local because these routes need CONDITIONAL auth — the
 * first-run window is public — which a static guard cannot express.
 */
export async function resolveSetupActor(request: Request): Promise<"cookie" | "admin" | "machine"> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (extractSessionToken(cookieHeader)) {
    const session = await resolveCookieSession(cookieHeader);
    if (!session) throw new UnauthorizedError();
    // The role lives in the app's `user_meta`, NOT on better-auth's session
    // user — the same source `requireAdmin` reads, so the two gates cannot
    // disagree about who is an admin.
    const role = await new UserMetaRepository(db).getRole(session.user.id);
    return role === "admin" ? "admin" : "cookie";
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    // Same accept-set as authGuard (subshell keys must match their row's
    // apiKeyId; non-subshell keys must be system-owned) — a self-minted or
    // unlinked key that 401s everywhere else must not 200 here.
    const issued = await isIssuedCredential(bearer).catch(() => false);
    if (issued) return "machine";
  }
  throw new UnauthorizedError();
}

/**
 * Gate for the harness endpoints once a user exists (security audit 2026-08,
 * F3): GETs need any authenticated actor; a write needs a COOKIE actor, and
 * once a user exists it needs an ADMIN one.
 *
 * **The admin requirement is not inherited, it was added in phase 2b.** The
 * write used to flip an enable flag; it now installs and removes plugins on
 * the control-plane host, which is the same operation
 * `POST /api/nodes/local/plugins` restricts to admins (`local`'s `canManage`
 * resolves to admin). Leaving this at "any signed-in user" would have made it
 * the weaker of two doors onto one operation: any user could have removed
 * claude-code from the host, hiding every user's claude-code presets and
 * refusing every claude-code launch instance-wide.
 *
 * Bearer keys are refused on writes even for an admin-owned key: this is
 * machine configuration with no machine consumer (the `subshell mcp` binary
 * never calls it; its endpoint census in packages/mcp-core/src/tools.ts covers
 * subshells, channels, presets reads and identities only).
 *
 * The pre-auth window stays open, because the wizard runs before any user
 * exists and the first person through it is the admin. What keeps that window
 * narrow is the built-in id check on the install handler, not this gate.
 */
async function requireHarnessAccess(request: Request, write: boolean): Promise<void> {
  if (!(await hasUsersProbe())) return; // first-run boot wizard stays public
  const actor = await resolveSetupActor(request);
  if (write && actor !== "admin") throw new ForbiddenError();
}

/**
 * Setup status + harness registry endpoints. `GET /status` is the only
 * always-public route (the login page needs it to find the wizard).
 *
 * `GET /harnesses` and the two `/plugins` writes are public ONLY while the
 * instance has no users — the setup wizard must work before an admin exists
 * — and gated afterwards (security audit 2026-08, F3): the GET requires any
 * authenticated actor, the writes an ADMIN cookie session. The writes install
 * and remove plugins on the control-plane host, which is the same operation
 * `POST /api/nodes/local/plugins` performs; both gates resolve to admin so
 * neither is the weaker door. See {@link requireHarnessAccess}.
 */
export const setupRoutes = new Elysia({ prefix: "/api/setup" })
  // For the named `ApiErrorResponse` the plugin routes below answer with.
  .use(apiModels)
  .get(
    "/status",
    async () => {
      // Same probe the harness gate consults — the wizard's view and the
      // gate's view of "does a user exist" must agree by construction.
      const hasUsers = await hasUsersProbe();
      return { needsSetup: !hasUsers, hasUsers } as const;
    },
    {
      response: SetupStatusSchema,
      detail: {
        operationId: "getSetupStatus",
        tags: ["setup"],
        description: "Whether the initial setup wizard should be shown",
      },
    },
  )
  .get(
    "/harnesses",
    async ({ request }) => {
      await requireHarnessAccess(request, false);
      const installed = await installedIdsHere();
      // The built-in catalog, deliberately (Task 9b's call-site audit): the
      // wizard answers "what can this build install with no network", which
      // is a question about THIS BINARY, not about the instance store. Its
      // install verb is built-in-only by construction, so a registry-only
      // plugin rendered here would offer nothing the wizard could do.
      return await Promise.all(builtInHarnesses().map(async (h) => await harnessInfo(h.id, installed.has(h.id))));
    },
    {
      response: t.Array(HarnessInfoSchema, { description: "All harness plugins" }),
      detail: {
        operationId: "listHarnesses",
        tags: ["setup"],
        description:
          "Lists all harness plugins and whether each is installed (public only while no user exists; authenticated afterwards)",
      },
    },
  )
  .post(
    "/plugins",
    async ({ request, body, status }) => {
      await requireHarnessAccess(request, true);
      // BUILT-IN IDS ONLY, and this is the load-bearing line of the handler.
      // `requireHarnessAccess` lets this through with no credential at all
      // while the instance has no users, because the wizard runs before an
      // admin exists. That is fine for bytes this build already carries. It
      // would not be fine the moment a registry sits behind the same command:
      // an unauthenticated caller on a fresh instance making this host fetch
      // and execute a package of their choosing is remote code execution, not
      // a widened config write. Phase 3 has to keep this closed or require
      // auth for setup writes; see spec 2026-09-09 §13.
      if (!(await builtInIds()).includes(body.pluginId)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: `"${body.pluginId}" is not a plugin this build carries`,
          }),
        );
      }
      await installLocalPlugin(body.pluginId);
      return await harnessInfo(body.pluginId, true);
    },
    {
      body: t.Object({ pluginId: t.String({ description: "Plugin id to install on this host" }) }),
      response: { 200: HarnessInfoSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "installSetupPlugin",
        tags: ["setup"],
        description:
          "Installs one built-in plugin on the control-plane host (public only while no user exists, cookie-gated afterwards; ids are limited to what this build carries)",
      },
    },
  )
  .delete(
    "/plugins/:pluginId",
    async ({ request, params, status }) => {
      await requireHarnessAccess(request, true);
      // Refused BEFORE acting. `harnessInfo` throws 404 for an id outside the
      // compiled registry, so answering with it after a successful removal
      // would report a failure for something that happened — and 404 is not
      // in this route's response map.
      if (!(await builtInIds()).includes(params.pluginId)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: `"${params.pluginId}" is not a plugin this build carries`,
          }),
        );
      }
      await uninstallLocalPlugin(params.pluginId);
      return await harnessInfo(params.pluginId, false);
    },
    {
      params: t.Object({ pluginId: t.String({ description: "Plugin id to remove from this host" }) }),
      response: { 200: HarnessInfoSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "uninstallSetupPlugin",
        tags: ["setup"],
        description:
          "Removes one plugin from the control-plane host. Removing one already absent succeeds: the caller asked for a state and that state holds",
      },
    },
  );
