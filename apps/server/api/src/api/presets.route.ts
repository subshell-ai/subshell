import { getHarness } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { getAllHarnessIds } from "@/api/harness-utils.js";
import { HarnessSchemaResponseSchema, PresetSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { resolveMcpLaunchForDisplay } from "@/services/mcp-resolve.js";

/** POSIX-style env var name; anything else is rejected before storage. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * First key of `env` that is not a valid env var name, if any. Enforced
 * handler-side (not via `t.Record` key validation, which cannot express it):
 * preset env reaches the tmux start command, so a key like `X; touch /tmp/pwned #`
 * is a shell-injection vector, and keys outrank the SUBSHELL_* credential layer.
 */
function findInvalidEnvName(env: Record<string, string> | undefined): string | undefined {
  return env ? Object.keys(env).find((key) => !ENV_VAR_NAME.test(key)) : undefined;
}

const CreatePresetBodySchema = t.Object({
  harnessId: t.String({ minLength: 1, description: "Harness plugin id" }),
  name: t.String({ minLength: 1, maxLength: 120, description: "Preset name" }),
  description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
  env: t.Optional(t.Record(t.String(), t.String(), { description: "Extra env vars" })),
  flags: t.Optional(t.Array(t.String(), { description: "Extra CLI flags" })),
  settings: t.Optional(t.Record(t.String(), t.Any(), { description: "Settings JSON object" })),
  configIsolation: t.Optional(t.Boolean({ description: "Config source isolation" })),
  restartOnExit: t.Optional(t.Boolean({ description: "New subshells auto-restart on exit" })),
});

/**
 * Preset endpoints. Reads (list, harness ids, harness schema) stay open to
 * every authenticated actor — the agent toolset needs `GET /api/presets`
 * (list_presets). Writes are cookie-only: preset.env OUTRANKS the
 * SUBSHELL_* credential layer when a subshell starts, so a bearer key that could
 * edit the owner's presets could redirect every future subshell/auto-restart
 * and harvest its bearer token. Machine credentials must not manage presets.
 */
export const presetRoutes = new Elysia({ prefix: "/api/presets" })
  .use(authGuard)
  .post(
    "/",
    async ({ body, user, actor }) => {
      if (actor !== "cookie") {
        throw new PresetError("forbidden", "Preset management requires a cookie session", 403);
      }
      const badEnv = findInvalidEnvName(body.env);
      if (badEnv !== undefined) {
        throw new PresetError("bad_request", `invalid env var name: ${badEnv}`, 400);
      }
      if (!getHarness(body.harnessId)) {
        throw new PresetError("bad_request", `Unknown harness: ${body.harnessId}`, 400);
      }
      // A preset is INSTANCE-scoped; only launches are node-scoped. Saving
      // settings must not require the agent's binary to answer on THIS
      // machine — the agent may live on any node the user later launches on
      // (spec 2026-09-13 follow-up). The gate is the instance's store state
      // (installed ∧ enabled ∧ ¬broken — the exact set
      // `GET /api/presets/harness-ids` answers); per-node binary detection
      // stays where it belongs, at the launch gate's per-node 409.
      if (!(await getAllHarnessIds()).includes(body.harnessId)) {
        throw new PresetError(
          "harness_unavailable",
          "That harness is unavailable (disabled or not installed on the server)",
          409,
        );
      }
      const repo = new PresetsRepository(db);
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
      });
      return created;
    },
    {
      body: CreatePresetBodySchema,
      response: PresetSchema,
      detail: {
        operationId: "createPreset",
        tags: ["presets"],
        description: "Creates a harness preset for the authenticated user (cookie session only)",
      },
    },
  )
  .get(
    "/",
    async ({ user, query, actor }) => {
      const repo = new PresetsRepository(db);
      const rows = await repo.listByUser(user.id, query.harnessId);
      // A disabled or not-installed harness makes its presets unavailable:
      // they are not listed anywhere (cards, new-subshell pickers), and
      // re-enabling/installing the harness brings them back — nothing here
      // is ever deleted.
      // The gate is STORE-scoped (spec 2026-09-13 follow-up): the instance's
      // plugin set decides availability, not this host's binary probe — a
      // preset for an agent installed only on another machine lists here,
      // because the preset was never node-scoped. Per-node compatibility is
      // the launch picker's grey matrix, client-side; the `?node=any` escape
      // hatch died with the LOCAL filter it existed to escape.
      const inStore = new Set(await getAllHarnessIds());
      const visible = rows.filter((p) => inStore.has(p.harnessId));
      if (actor === "cookie") return visible;
      // Reads stay open to bearer actors for `list_presets`, but that
      // tool only projects {id,name,harnessId} — the REST body's `envJson`
      // was every operator secret (preset.env is secret storage by
      // convention, and it OUTRANKS the SUBSHELL_* credential layer) harvestable
      // by any subshell token. Redact it for machine actors. `flagsJson` and
      // `settingsJson` are NOT secret storage by convention and stay
      // (nothing strips or seals them elsewhere either), so only envJson is
      // nulled. The cookie/browser preset editor keeps the full rows.
      return visible.map((p) => ({ ...p, envJson: null }));
    },
    {
      query: t.Object({
        harnessId: t.Optional(t.String({ description: "Filter by harness id" })),
      }),
      response: t.Array(PresetSchema, { description: "User's presets" }),
      detail: {
        operationId: "listPresets",
        tags: ["presets"],
        description:
          "Lists the authenticated user's presets (bearer/machine actors get envJson redacted to null; cookie sessions see full rows). Filtered to harnesses the INSTANCE store offers — installed, enabled, not broken",
      },
    },
  )
  .get(
    "/harness-ids",
    async () => {
      return { ids: await getAllHarnessIds() };
    },
    {
      response: t.Object({ ids: t.Array(t.String({ description: "Harness plugin id the instance offers" })) }),
      detail: {
        operationId: "listHarnessIds",
        tags: ["presets"],
        description:
          "The harness plugin ids this instance offers (installed and enabled — not the compiled-in catalog)",
      },
    },
  )
  .get(
    "/harnesses/:id/schema",
    async ({ params }) => {
      const harness = getHarness(params.id);
      if (!harness) throw new PresetError("not_found", "Unknown harness");
      return {
        settingsFields: harness.settingsFields(),
        suggestedEnv: harness.suggestedEnv(),
        suggestedFlags: harness.suggestedFlags(),
        // The manual steps embed this deployment's real `subshell mcp` launch
        // (display variant: an editor page must never fail on resolution).
        mcp: harness.mcpSetup(resolveMcpLaunchForDisplay()),
      };
    },
    {
      params: t.Object({ id: t.String({ description: "Harness plugin id" }) }),
      response: HarnessSchemaResponseSchema,
      detail: {
        operationId: "getHarnessSchema",
        tags: ["presets"],
        description: "Settings schema and env/flag suggestions for one harness",
      },
    },
  )
  .put(
    "/:id",
    async ({ params, body, user, actor }) => {
      if (actor !== "cookie") {
        throw new PresetError("forbidden", "Preset management requires a cookie session", 403);
      }
      const badEnv = findInvalidEnvName(body.env);
      if (badEnv !== undefined) {
        throw new PresetError("bad_request", `invalid env var name: ${badEnv}`, 400);
      }
      const repo = new PresetsRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) {
        throw new PresetError("not_found", "Preset not found");
      }
      const updated = await repo.update(params.id, {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        envJson: body.env ? JSON.stringify(body.env) : existing.envJson,
        flagsJson: body.flags ? JSON.stringify(body.flags) : existing.flagsJson,
        settingsJson: body.settings ? JSON.stringify(body.settings) : existing.settingsJson,
        configIsolation: body.configIsolation !== undefined ? (body.configIsolation ? 1 : 0) : existing.configIsolation,
        restartOnExit: body.restartOnExit !== undefined ? (body.restartOnExit ? 1 : 0) : existing.restartOnExit,
      });
      if (!updated) throw new PresetError("not_found", "Preset not found");
      return updated;
    },
    {
      body: t.Partial(CreatePresetBodySchema),
      response: PresetSchema,
      detail: {
        operationId: "updatePreset",
        tags: ["presets"],
        description: "Updates a preset owned by the authenticated user (cookie session only)",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, user, actor }) => {
      if (actor !== "cookie") {
        throw new PresetError("forbidden", "Preset management requires a cookie session", 403);
      }
      const repo = new PresetsRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) {
        throw new PresetError("not_found", "Preset not found");
      }
      // Every preset is deletable — there is no protected Default any more.
      // Rows that used it survive as presetless launches (the repository
      // nulls `subshells.preset_id`; spec 2026-09-13 §6).
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      response: t.Object({ ok: t.Boolean() }),
      detail: {
        operationId: "deletePreset",
        tags: ["presets"],
        description: "Deletes a preset owned by the authenticated user (cookie session only)",
      },
    },
  );

/** Route error with an HTTP status; Elysia maps `status` to the response code. */
class PresetError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 404) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
