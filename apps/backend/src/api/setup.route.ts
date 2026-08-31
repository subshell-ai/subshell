import { ALL_HARNESSES, getHarness } from "@internal/harnesses";
import { Elysia, t } from "elysia";
import { ForbiddenError, isIssuedCredential, UnauthorizedError } from "@/api/auth-guard.js";
import { HarnessInfoSchema } from "@/api/models.js";
import { IS_TEST } from "@/constants.js";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";
import { ensureDefaultProfilesForHarness } from "@/services/default-profiles.js";
import { logger } from "@/utils/logger.js";

const SetupStatusSchema = t.Object({
  needsSetup: t.Boolean({ description: "True until the first user is registered" }),
  hasUsers: t.Boolean({ description: "Whether any user exists" }),
});

const EnableBodySchema = t.Object({
  enabled: t.Boolean({ description: "Whether the harness should be available for profiles" }),
});

/** Route error with an HTTP status; Elysia maps `status` to the response code. */
class SetupError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Report one plugin with fresh detection: install state and version are
 * probed per request (a re-check is just another GET), enabled state comes
 * from the lazily-written `harnessPlugins` row.
 */
async function harnessInfo(id: string, enabled: boolean) {
  const h = getHarness(id);
  if (!h) throw new SetupError("not_found", "Unknown harness", 404);
  const installed = await h.isInstalled();
  return {
    id: h.id,
    name: h.name,
    binary: h.binaryName,
    description: h.description,
    icon: h.icon,
    installed,
    version: installed ? ((await h.getVersion()) ?? undefined) : undefined,
    enabled,
    install: h.installHint,
  } as const;
}

async function enabledStatesById(): Promise<Map<string, boolean>> {
  const repo = new HarnessPluginsRepository(db);
  return await repo.getEnabledStates(ALL_HARNESSES.map((h) => h.id));
}

/** Counts `user_meta` rows — the instance's "a user exists" truth. */
async function countUserMeta(): Promise<number> {
  const row = await db
    .selectFrom("userMeta")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
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
  return (await countUserMeta()) > 0;
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
async function resolveSetupActor(request: Request): Promise<"cookie" | "machine"> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (extractSessionToken(cookieHeader)) {
    const session = await resolveCookieSession(cookieHeader);
    if (!session) throw new UnauthorizedError();
    return "cookie";
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    // Same accept-set as authGuard (session keys must match their row's
    // apiKeyId; non-session keys must be system-owned) — a self-minted or
    // unlinked key that 401s everywhere else must not 200 here.
    const issued = await isIssuedCredential(bearer).catch(() => false);
    if (issued) return "machine";
  }
  throw new UnauthorizedError();
}

/**
 * Gate for the harness endpoints once a user exists (security audit 2026-08,
 * F3): GETs need any authenticated actor; PATCH additionally needs a COOKIE
 * actor. PATCH flips this machine's harness enable/disable state — machine
 * configuration with no machine consumer (the `mote mcp` binary never calls
 * it; its endpoint census in src/mcp/tools.ts covers sessions, channels,
 * profiles reads and identities only), so bearer keys have no reason to
 * exist on this write and are refused with 403 after authenticating.
 */
async function requireHarnessAccess(request: Request, write: boolean): Promise<void> {
  if (!(await hasUsersProbe())) return; // first-run boot wizard stays public
  const actor = await resolveSetupActor(request);
  if (write && actor !== "cookie") throw new ForbiddenError();
}

/**
 * Setup status + harness registry endpoints. `GET /status` is the only
 * always-public route (the login page needs it to find the wizard).
 * `GET /harnesses` and `PATCH /harnesses/:id` are public ONLY while the
 * instance has no users — the setup wizard must work before an admin exists
 * — and gated afterwards (security audit 2026-08, F3): the GET requires any
 * authenticated actor, the PATCH (a machine-config write) a cookie session.
 * See {@link requireHarnessAccess}.
 */
export const setupRoutes = new Elysia({ prefix: "/api/setup" })
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
      const states = await enabledStatesById();
      return await Promise.all(
        ALL_HARNESSES.map(async (h) => await harnessInfo(h.id, states.get(h.id) ?? h.enabledByDefault)),
      );
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
  .patch(
    "/harnesses/:id",
    async ({ request, params, body }) => {
      await requireHarnessAccess(request, true);
      const h = getHarness(params.id);
      if (!h) throw new SetupError("not_found", "Unknown harness", 404);
      if (body.enabled && !(await h.isInstalled())) {
        // Turning a harness on re-runs detection: the "I just installed it,
        // make it usable" flow is exactly this toggle, with no separate
        // check step to invent. Disabling never needs a check.
        throw new SetupError("not_installed", `"${h.name}" is not installed on this machine`, 409);
      }
      await new HarnessPluginsRepository(db).setEnabled(h.id, body.enabled);
      // Enabling a harness makes it usable for everyone, so guarantee each
      // user has a Default profile for it (insert-only when they have none).
      // Disabling is left alone — its profiles just hide until it returns.
      // BEST-EFFORT: the enable itself already committed, so a seeding failure
      // must not 500 (and flip the client's switch back) over an optional
      // convenience — the boot sweep heals it; log so it is diagnosable.
      if (body.enabled) {
        await ensureDefaultProfilesForHarness(db, h.id).catch((err) => {
          logger.withError(err).warn(`default-profile seeding failed on enabling harness ${h.id}`);
        });
      }
      return await harnessInfo(h.id, body.enabled);
    },
    {
      params: t.Object({ id: t.String({ description: "Harness plugin id" }) }),
      body: EnableBodySchema,
      response: HarnessInfoSchema,
      detail: {
        operationId: "setHarnessEnabled",
        tags: ["setup"],
        description:
          "Enables (after a fresh install check) or disables a harness plugin (public only while no user exists; cookie session afterwards)",
      },
    },
  );
