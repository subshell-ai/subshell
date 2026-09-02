import { getHarness } from "@internal/harnesses";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { getAllHarnessIds, harnessUsable, usableHarnessIds } from "@/api/harness-utils.js";
import { HarnessSchemaResponseSchema, ProfileSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { loadNodeAccess } from "@/lib/node-access.js";
import { resolveMcpLaunchForDisplay } from "@/services/mcp-launch.js";

/** POSIX-style env var name; anything else is rejected before storage. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * First key of `env` that is not a valid env var name, if any. Enforced
 * handler-side (not via `t.Record` key validation, which cannot express it):
 * profile env reaches the tmux start command, so a key like `X; touch /tmp/pwned #`
 * is a shell-injection vector, and keys outrank the MOTE_* credential layer.
 */
function findInvalidEnvName(env: Record<string, string> | undefined): string | undefined {
  return env ? Object.keys(env).find((key) => !ENV_VAR_NAME.test(key)) : undefined;
}

const CreateProfileBodySchema = t.Object({
  harnessId: t.String({ minLength: 1, description: "Harness plugin id" }),
  name: t.String({ minLength: 1, maxLength: 120, description: "Profile name" }),
  description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
  env: t.Optional(t.Record(t.String(), t.String(), { description: "Extra env vars" })),
  flags: t.Optional(t.Array(t.String(), { description: "Extra CLI flags" })),
  settings: t.Optional(t.Record(t.String(), t.Any(), { description: "Settings JSON object" })),
  configIsolation: t.Optional(t.Boolean({ description: "Config source isolation" })),
  restartOnExit: t.Optional(t.Boolean({ description: "New sessions auto-restart on exit" })),
  nodeId: t.Optional(
    t.Nullable(t.String({ minLength: 1, description: "Node id to pin this profile to" }), {
      description: "Pinned launch node; null/omitted = any node",
    }),
  ),
});

/**
 * Validate a pin target: the node must merely be VISIBLE to the caller
 * (spec 2026-08-31 §6.2) — pinning is a preference, not a manage action.
 * Invisible or unknown collapse to the same 404 (no existence leak, the
 * node-routes discipline); an empty string was already rejected by the
 * schema (`minLength: 1` → 400).
 * @returns the caller's effective access when the node is visible
 */
async function assertNodeVisible(userId: string, nodeId: string): Promise<void> {
  const { access } = await loadNodeAccess(
    { nodes: new NodesRepository(db), shares: new NodeSharesRepository(db), userMeta: new UserMetaRepository(db) },
    userId,
    nodeId,
  );
  if (access === "none") {
    // Same 404 for absent and invisible — ids cannot be probed through the pin.
    throw new ProfileError("not_found", "Node not found", 404);
  }
}

/**
 * Profile endpoints. Reads (list, harness ids, harness schema) stay open to
 * every authenticated actor — the agent toolset needs `GET /api/profiles`
 * (list_profiles). Writes are cookie-only: profile.env OUTRANKS the
 * MOTE_* credential layer when a session starts, so a bearer key that could
 * edit the owner's profiles could redirect every future session/auto-restart
 * and harvest its bearer token. Machine credentials must not manage profiles.
 */
export const profileRoutes = new Elysia({ prefix: "/api/profiles" })
  .use(authGuard)
  .post(
    "/",
    async ({ body, user, actor }) => {
      if (actor !== "cookie") {
        throw new ProfileError("forbidden", "Profile management requires a cookie session", 403);
      }
      const badEnv = findInvalidEnvName(body.env);
      if (badEnv !== undefined) {
        throw new ProfileError("bad_request", `invalid env var name: ${badEnv}`, 400);
      }
      if (!getHarness(body.harnessId)) {
        throw new ProfileError("bad_request", `Unknown harness: ${body.harnessId}`, 400);
      }
      if (!(await harnessUsable(body.harnessId))) {
        throw new ProfileError("harness_unavailable", "That harness is unavailable (disabled or not installed)", 409);
      }
      // Pin validation happens BEFORE the row exists — a bad node never
      // leaves a half-profile behind (and a null/absent pin = "any node").
      if (body.nodeId !== undefined && body.nodeId !== null) {
        await assertNodeVisible(user.id, body.nodeId);
      }
      const repo = new ProfilesRepository(db);
      const created = await repo.create({
        id: crypto.randomUUID(),
        userId: user.id,
        harnessId: body.harnessId,
        name: body.name,
        description: body.description ?? null,
        envJson: body.env ? JSON.stringify(body.env) : null,
        flagsJson: body.flags ? JSON.stringify(body.flags) : null,
        settingsJson: body.settings ? JSON.stringify(body.settings) : null,
        configIsolation: body.configIsolation ? 1 : 0,
        restartOnExit: body.restartOnExit ? 1 : 0,
        nodeId: body.nodeId ?? null,
      });
      return created;
    },
    {
      body: CreateProfileBodySchema,
      response: ProfileSchema,
      detail: {
        operationId: "createProfile",
        tags: ["profiles"],
        description: "Creates a harness profile for the authenticated user (cookie session only)",
      },
    },
  )
  .get(
    "/",
    async ({ user, query, actor }) => {
      const repo = new ProfilesRepository(db);
      const rows = await repo.listByUser(user.id, query.harnessId);
      // A disabled or not-installed harness makes its profiles unavailable:
      // they are not listed anywhere (cards, new-session pickers), and
      // re-enabling/installing the harness brings them back — nothing here
      // is ever deleted.
      // LOCAL-scoped by design in phase 1 (usableHarnessIds() probes this
      // machine): a profile usable anywhere still gates on local. Per-node
      // launch gating (harnessUsable(id, session.nodeId)) arrives with the
      // phase-2 launch flow (spec 2026-08-31 §6.2/§6.6).
      const usable = await usableHarnessIds();
      const visible = rows.filter((p) => usable.has(p.harnessId));
      if (actor === "cookie") return visible;
      // Reads stay open to bearer actors for `list_profiles`, but that
      // tool only projects {id,name,harnessId} — the REST body's `envJson`
      // was every operator secret (profile.env is secret storage by
      // convention, and it OUTRANKS the MOTE_* credential layer) harvestable
      // by any session token. Redact it for machine actors. `flagsJson` and
      // `settingsJson` are NOT secret storage by convention and stay
      // (nothing strips or seals them elsewhere either), so only envJson is
      // nulled. The cookie/browser profile editor keeps the full rows.
      return visible.map((p) => ({ ...p, envJson: null }));
    },
    {
      query: t.Object({
        harnessId: t.Optional(t.String({ description: "Filter by harness id" })),
      }),
      response: t.Array(ProfileSchema, { description: "User's profiles" }),
      detail: {
        operationId: "listProfiles",
        tags: ["profiles"],
        description:
          "Lists the authenticated user's profiles (bearer/machine actors get envJson redacted to null; cookie sessions see full rows)",
      },
    },
  )
  .get(
    "/harness-ids",
    async () => {
      return { ids: getAllHarnessIds() };
    },
    {
      response: t.Object({ ids: t.Array(t.String()) }),
      detail: {
        operationId: "listHarnessIds",
        tags: ["profiles"],
        description: "All known harness plugin ids",
      },
    },
  )
  .get(
    "/harnesses/:id/schema",
    async ({ params }) => {
      const harness = getHarness(params.id);
      if (!harness) throw new ProfileError("not_found", "Unknown harness");
      return {
        settingsFields: harness.settingsFields(),
        suggestedEnv: harness.suggestedEnv(),
        suggestedFlags: harness.suggestedFlags(),
        // The manual steps embed this deployment's real mote-mcp launch
        // (display variant: an editor page must never fail on resolution).
        mcp: harness.mcpSetup(resolveMcpLaunchForDisplay()),
      };
    },
    {
      params: t.Object({ id: t.String({ description: "Harness plugin id" }) }),
      response: HarnessSchemaResponseSchema,
      detail: {
        operationId: "getHarnessSchema",
        tags: ["profiles"],
        description: "Settings schema and env/flag suggestions for one harness",
      },
    },
  )
  .put(
    "/:id",
    async ({ params, body, user, actor }) => {
      if (actor !== "cookie") {
        throw new ProfileError("forbidden", "Profile management requires a cookie session", 403);
      }
      const badEnv = findInvalidEnvName(body.env);
      if (badEnv !== undefined) {
        throw new ProfileError("bad_request", `invalid env var name: ${badEnv}`, 400);
      }
      const repo = new ProfilesRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) {
        throw new ProfileError("not_found", "Profile not found");
      }
      // Same visibility rule as create; an explicit null UNPINS (any node),
      // an omitted field keeps the existing pin (partial-update semantics).
      if (body.nodeId !== undefined && body.nodeId !== null) {
        await assertNodeVisible(user.id, body.nodeId);
      }
      const updated = await repo.update(params.id, {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        envJson: body.env ? JSON.stringify(body.env) : existing.envJson,
        flagsJson: body.flags ? JSON.stringify(body.flags) : existing.flagsJson,
        settingsJson: body.settings ? JSON.stringify(body.settings) : existing.settingsJson,
        configIsolation: body.configIsolation !== undefined ? (body.configIsolation ? 1 : 0) : existing.configIsolation,
        restartOnExit: body.restartOnExit !== undefined ? (body.restartOnExit ? 1 : 0) : existing.restartOnExit,
        nodeId: body.nodeId !== undefined ? body.nodeId : existing.nodeId,
      });
      if (!updated) throw new ProfileError("not_found", "Profile not found");
      return updated;
    },
    {
      body: t.Partial(CreateProfileBodySchema),
      response: ProfileSchema,
      detail: {
        operationId: "updateProfile",
        tags: ["profiles"],
        description: "Updates a profile owned by the authenticated user (cookie session only)",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, user, actor }) => {
      if (actor !== "cookie") {
        throw new ProfileError("forbidden", "Profile management requires a cookie session", 403);
      }
      const repo = new ProfilesRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) {
        throw new ProfileError("not_found", "Profile not found");
      }
      // Auto-seeded Defaults are unremovable — every user keeps a working
      // launch path per enabled harness. It is still fully editable; if it
      // gets in the way, disable the harness (hides everything it owns,
      // including this) rather than deleting.
      if (existing.isDefault === 1) {
        throw new ProfileError(
          "default_profile",
          "Default profiles can't be deleted — edit it instead, or disable the harness to hide it",
          409,
        );
      }
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      response: t.Object({ ok: t.Boolean() }),
      detail: {
        operationId: "deleteProfile",
        tags: ["profiles"],
        description: "Deletes a profile owned by the authenticated user (cookie session only)",
      },
    },
  );

/** Route error with an HTTP status; Elysia maps `status` to the response code. */
class ProfileError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 404) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
