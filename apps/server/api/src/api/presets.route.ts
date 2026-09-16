import { getHarness, type SettingsField } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { getAllHarnessIds } from "@/api/harness-utils.js";
import { HarnessSchemaResponseSchema, PresetSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { resolveMcpLaunchForDisplay } from "@/services/mcp-resolve.js";

/**
 * A settings field the preset editor can actually hold.
 *
 * `secret` is the NETWORK half of the contract: a write-only value the host
 * keeps in a 0600 file and hydrates into a process it spawns. A preset is a
 * database row a user owns and a launch reads, so it has nowhere to put one —
 * a harness declaring a secret field would otherwise get a password box in the
 * preset editor whose value had no store. The response schema stays narrow
 * (`SettingsFieldSchema` names four kinds), and this is what makes the data
 * agree with it, rather than widening the schema and hoping no harness ever
 * does it.
 */
function isPresetSettingsField(
  field: SettingsField,
): field is SettingsField & { type: "string" | "boolean" | "number" | "select" } {
  return field.type !== "secret";
}

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
 * `PUT /:id` body — deliberately NOT `t.Partial(CreatePresetBodySchema)`:
 * a preset's harness is fixed at create (the handler never reads one, so a
 * `harnessId` in a PUT body used to answer 200 with nothing changed, exactly
 * when "move this preset to another agent" became a plausible request), and
 * the honest answer to any field the update cannot apply is a 400 about the
 * unknown property. POST stays lenient: a stray `nodeId` there is stripped,
 * pinned by the no-node-dimension suite.
 *
 * `additionalProperties: false` here is what OpenAPI DOCUMENTS, not what
 * refuses: measured on elysia 1.4.29, an unknown body key is stripped and
 * validated clean, so the 400 is enforced by the route's transform against
 * {@link UPDATE_PRESET_KEYS} — the same key set, kept adjacent to stay one
 * fact. (Schema-validation strictness is NOT the refusal on this Elysia;
 * do not "simplify" the transform away on the schema's word.)
 */
const UpdatePresetBodySchema = t.Object(
  {
    name: t.Optional(t.String({ minLength: 1, maxLength: 120, description: "Preset name" })),
    description: t.Optional(t.String({ maxLength: 500, description: "Longer description" })),
    env: t.Optional(t.Record(t.String(), t.String(), { description: "Extra env vars" })),
    flags: t.Optional(t.Array(t.String(), { description: "Extra CLI flags" })),
    settings: t.Optional(t.Record(t.String(), t.Any(), { description: "Settings JSON object" })),
    configIsolation: t.Optional(t.Boolean({ description: "Config source isolation" })),
    restartOnExit: t.Optional(t.Boolean({ description: "New subshells auto-restart on exit" })),
  },
  { additionalProperties: false },
);

/** The keys `PUT /:id` applies — mirrors {@link UpdatePresetBodySchema}. */
const UPDATE_PRESET_KEYS = new Set([
  "name",
  "description",
  "env",
  "flags",
  "settings",
  "configIsolation",
  "restartOnExit",
]);

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
      // 400 vs the 409 below tracks PROVENANCE, and the difference is
      // honesty rather than an accident: a built-in is compiled in, so an
      // uninstalled one still resolves here and we can say "unavailable"
      // (409). A third-party plugin that was uninstalled leaves nothing
      // behind — the id names nothing this process has ever seen — so it is
      // indistinguishable from a typo and answers 400. `POST /api/subshells`
      // splits the same way, from the same two checks.
      if (!getHarness(body.harnessId)) {
        throw new PresetError("bad_request", `Unknown harness: ${body.harnessId}`, 400);
      }
      // A preset is INSTANCE-scoped; only launches are node-scoped. Saving
      // settings must not require the agent's binary to answer on THIS
      // machine — the agent may live on any node the user later launches on
      // (spec 2026-09-13 follow-up). The gate is the instance's store state
      // (installed ∧ enabled ∧ ¬broken — the exact set
      // `GET /api/presets/harness-ids` answers; a BROKEN plugin never reaches
      // this line — it resolves to nothing, so the 400 above catches it
      // first). Per-node binary detection stays where it belongs, at the
      // launch gate's per-node 409.
      if (!(await getAllHarnessIds()).includes(body.harnessId)) {
        throw new PresetError(
          "harness_unavailable",
          "That harness is unavailable (disabled or not installed on the server)",
          409,
        );
      }
      const repo = new PresetsRepository(db);
      try {
        return await repo.create({
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
      } catch (err) {
        if (isDuplicateName(err)) {
          throw new PresetError("duplicate", `You already have a ${body.harnessId} preset named "${body.name}"`, 409);
        }
        throw err;
      }
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
          "The harness plugin ids this instance offers (installed, enabled and loadable — not the compiled-in catalog)",
      },
    },
  )
  .get(
    "/harnesses/:id/schema",
    async ({ params }) => {
      // Deliberately NOT store-gated, unlike the three reads that agree on
      // `getAllHarnessIds()`. This is static catalog metadata for an
      // AUTHENTICATED caller, and the editor needs it for a preset that
      // already exists: gating it would blank the fields of a saved preset
      // whose harness was later disabled, so the row could no longer be read
      // or corrected — a worse answer than serving a schema for something
      // that cannot currently launch.
      const harness = getHarness(params.id);
      if (!harness) throw new PresetError("not_found", "Unknown harness");
      return {
        // See {@link isPresetSettingsField}: a credential has no home here.
        settingsFields: harness.settingsFields().filter(isPresetSettingsField),
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
      const name = body.name ?? existing.name;
      let updated: Awaited<ReturnType<typeof repo.update>>;
      try {
        updated = await repo.update(params.id, {
          name,
          description: body.description ?? existing.description,
          envJson: body.env ? JSON.stringify(body.env) : existing.envJson,
          flagsJson: body.flags ? JSON.stringify(body.flags) : existing.flagsJson,
          settingsJson: body.settings ? JSON.stringify(body.settings) : existing.settingsJson,
          configIsolation:
            body.configIsolation !== undefined ? (body.configIsolation ? 1 : 0) : existing.configIsolation,
          restartOnExit: body.restartOnExit !== undefined ? (body.restartOnExit ? 1 : 0) : existing.restartOnExit,
        });
      } catch (err) {
        if (isDuplicateName(err)) {
          throw new PresetError("duplicate", `You already have a ${existing.harnessId} preset named "${name}"`, 409);
        }
        throw err;
      }
      if (!updated) throw new PresetError("not_found", "Preset not found");
      return updated;
    },
    {
      // Runs BEFORE validation, on the parsed (unstripped) body — the only
      // place a stripped-by-default Elysia can still see the keys it would
      // eat. Reject every key the update cannot apply, naming the first.
      transform({ body }) {
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const stray = Object.keys(body).find((key) => !UPDATE_PRESET_KEYS.has(key));
          if (stray !== undefined) {
            throw new PresetError("bad_request", `Unknown property in preset update body: ${stray}`, 400);
          }
        }
      },
      body: UpdatePresetBodySchema,
      response: PresetSchema,
      detail: {
        operationId: "updatePreset",
        tags: ["presets"],
        description:
          "Updates a preset owned by the authenticated user (cookie session only); the harness is fixed at create and any field a PUT cannot apply is refused",
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
      response: t.Object({ ok: t.Boolean({ description: "True when the preset was deleted" }) }),
      detail: {
        operationId: "deletePreset",
        tags: ["presets"],
        description: "Deletes a preset owned by the authenticated user (cookie session only)",
      },
    },
  );

/**
 * Elevates the unique-index violation on `(user_id, harness_id, name)` to a
 * 409 — the same shape `workspaces.service.ts` uses for its own label index
 * (spec 2026-09-13 follow-up, migration 0028). Caught rather than
 * pre-checked: a SELECT-then-INSERT is a race, and the index is the thing
 * that is actually true.
 */
function isDuplicateName(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

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
