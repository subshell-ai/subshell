import { builtInHarnesses, builtInIds, getBuiltInHarness, getHarness, parsePackageSpec } from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { Elysia, type Static, t } from "elysia";
import { authGuard, HttpError, requireAdmin } from "@/api/auth-guard.js";
import { HarnessStateError } from "@/api/harness-utils.js";
import { IS_TEST, SUBSHELL_PLUGIN_REGISTRY_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { installLocalPlugin, localPluginReports, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";

/**
 * The instance-level plugins door (spec 2026-09-10 §6, §6.1).
 *
 * `<SUBSHELL_SERVER_DATA_DIR>/plugins/` is the ONE plugin store: installing
 * here arms every node, and that is why the per-node
 * `POST /api/nodes/:id/plugins` route died. Installing runs third-party code
 * IN THIS PROCESS — the one that holds the node signing keypair — so every
 * write is a cookie-admin act (§8); reads are open to any authenticated
 * actor, because "what is installed and offered" is not a management secret
 * and the launch pickers read against it.
 *
 * The lifecycle (§6.1): `enabled` is a DB flag (absent row = enabled), never
 * in `install.json` which the installer rewrites; uninstalling a plugin that
 * other people's profiles use ASKS first (the impact endpoint feeds the
 * dialog), and `mode=delete` is the one place the Default-profile guard is
 * deliberately bypassed (see `ProfilesRepository.deleteByHarness`).
 *
 * | verb   | path                          | gate              |
 * |--------|-------------------------------|-------------------|
 * | GET    | /api/plugins                  | any authenticated |
 * | POST   | /api/plugins                  | cookie admin      |
 * | PATCH  | /api/plugins/:pluginId        | cookie admin      |
 * | GET    | /api/plugins/:pluginId/impact | cookie admin      |
 * | DELETE | /api/plugins/:pluginId        | cookie admin      |
 */

/** Which of the two install doors the bytes came through. */
const InstallSourceSchema = t.Union([t.Literal("embedded"), t.Literal("registry")], {
  description: "Whether the installed bytes are this build's embedded copy or a fetched npm package",
});

/** One plugin as the instance page renders it: identity × installed × enabled. */
const PluginRowSchema = t.Object({
  id: t.String({ description: "Plugin id (its directory name under the instance's plugins dir)" }),
  name: t.String({ description: "Display name, from the installed plugin or this build's manifest" }),
  description: t.String({ description: "One-line description" }),
  icon: t.Optional(t.String({ description: "Icon label" })),
  binary: t.Optional(
    t.String({
      description: "Driven program's command name, from the plugin this process resolves (built-in or installed)",
    }),
  ),
  version: t.Optional(t.String({ description: "Installed package version (absent when not installed)" })),
  installed: t.Boolean({ description: "Whether the instance store holds this plugin" }),
  enabled: t.Boolean({
    description: "Offered or merely held (spec §6.1). An install the flag table never touched reads enabled",
  }),
  builtIn: t.Boolean({
    description:
      "True when THIS build ships the plugin (one-click install from the catalog); false for a registry-installed third-party plugin, which reinstalls only by package spec",
  }),
  broken: t.Optional(
    t.String({
      description:
        "Why the plugin will not load in the control-plane process. Present means it keeps its row so a page can say why every launch of it fails",
    }),
  ),
});

const ListResponseSchema = t.Object({
  plugins: t.Array(PluginRowSchema, {
    description: "The merge of this build's embedded catalog and the instance store, id-sorted",
  }),
});

const InstallBodySchema = t.Object({
  pluginId: t.String({ description: "Plugin id to install, e.g. 'claude-code'" }),
  spec: t.Optional(
    t.String({
      description:
        "npm package spec to fetch (name, @scope/name, optionally @version/@dist-tag); absent installs this build's embedded copy",
    }),
  ),
});

const PatchBodySchema = t.Object({
  enabled: t.Boolean({
    description:
      "Offer the plugin (true) or hold its bytes without offering them (false). Profiles are never touched in either direction",
  }),
});

const ImpactResponseSchema = t.Object({
  profiles: t.Number({ description: "Profiles using this harness, across every user" }),
  distinctUsers: t.Number({
    description:
      "Every user who owns one of these profiles, the caller included — the 'across N users' count the uninstall dialog renders",
  }),
  defaults: t.Number({ description: "How many are auto-seeded Defaults (mode=delete removes these too)" }),
  runningSubshells: t.Number({ description: "RUNNING subshells on this harness. Uninstalling touches none of them" }),
});

const DeleteResponseSchema = t.Object({
  ok: t.Boolean({ description: "Always true on success; an already-absent plugin is the state the caller asked for" }),
  mode: t.Union([t.Literal("keep"), t.Literal("delete")], {
    description: "The mode the uninstall ran in (defaults to keep)",
  }),
  profilesRemoved: t.Number({ description: "Profiles deleted (0 for keep, and 0 for a plugin nothing used)" }),
});

const PARAMS = t.Object({ pluginId: t.String({ description: "Plugin id" }) });

/** The shape a plugin id may take — ids become directory names (mirrors pane-runtime's `assertSafeId`). */
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let registryUrlOverride: string | undefined;

/**
 * Test seam for the npm registry a spec install fetches from (the same
 * `setHasUsersProbeForTests` pattern, and for the same reason: the production
 * path must never be able to redirect a real install, so the setter refuses
 * to run outside the test suite).
 * @internal
 */
export function setPluginsRegistryUrlForTests(url: string | null): void {
  if (!IS_TEST) throw new Error("setPluginsRegistryUrlForTests is a test-only seam");
  registryUrlOverride = url ?? undefined;
}

/** Both stores behind a row, read together so one request costs one disk pass. */
interface CatalogSources {
  /** Every report on disk (installed, broken ones included) */
  installed: PluginReportWire[];
  /** `pluginId → enabled` for the rows the DB has an explicit opinion about */
  state: Map<string, boolean>;
}

async function readSources(): Promise<CatalogSources> {
  const [installed, state] = await Promise.all([localPluginReports(), new PluginStateRepository(db).stateByPluginId()]);
  return { installed, state };
}

/**
 * One plugin's row, from whichever sources know about it.
 *
 * A plugin in the embedded catalog but not on disk gets a row
 * (`installed: false`, the page's one-click region); an installed plugin
 * outside the catalog gets one too (report identity, `builtIn: false`).
 * Neither knows the id → undefined, and `requireRow` turns that into a 404.
 */
function toRow(id: string, s: CatalogSources): Static<typeof PluginRowSchema> | undefined {
  const report = s.installed.find((r) => r.id === id);
  // `harness` resolves the INSTALLED plugin too (the Task 9b overlay), so it
  // is the identity source for any row this process can say anything about.
  // `builtIn` deliberately asks a different, narrower question — see
  // `getBuiltInHarness`.
  const harness = getHarness(id);
  if (!report && !harness) return undefined;
  const icon = report?.icon ?? harness?.icon;
  const row: Static<typeof PluginRowSchema> = {
    id,
    name: report?.name ?? harness?.name ?? id,
    description: report?.description ?? harness?.description ?? "",
    ...(icon ? { icon } : {}),
    ...(harness ? { binary: harness.binaryName } : {}),
    ...(report?.version ? { version: report.version } : {}),
    installed: report !== undefined,
    enabled: s.state.get(id) !== false, // an absent row means enabled
    // "This build carries the bytes" — the one-click question. Once the
    // overlay exists, `getHarness` is the wrong test for it: a registry
    // plugin resolves there too, and offering "install this build's copy"
    // of a plugin this build does not carry is the lie this splits.
    builtIn: getBuiltInHarness(id) !== undefined,
    ...(report?.broken ? { broken: report.broken } : {}),
  };
  return row;
}

/** The row for a plugin the request named; a plugin neither source knows is a 404. */
async function requireRow(id: string, s: CatalogSources): Promise<Static<typeof PluginRowSchema>> {
  const row = toRow(id, s);
  if (!row) throw new HttpError(404, `"${id}" is not a plugin this instance knows`);
  return row;
}

/** Reads: open to any authenticated actor. The writes below take `requireAdmin`. */
const readRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async () => {
      const s = await readSources();
      // The union the instance page needs: everything on disk, plus every
      // built-in this build could install. `builtInHarnesses()` here is the
      // catalog question (Task 9's call-site audit): "what can I one-click
      // install", never "what is installed" — which is why it reads the
      // compiled set rather than the merged one.
      const ids = new Set<string>(s.installed.map((r) => r.id));
      for (const h of builtInHarnesses()) ids.add(h.id);
      const plugins = [...ids].sort().flatMap((id) => {
        const row = toRow(id, s);
        return row ? [row] : [];
      });
      return { plugins };
    },
    {
      response: ListResponseSchema,
      detail: {
        operationId: "listInstancePlugins",
        tags: ["plugins"],
        description:
          "The instance's plugin catalog: the embedded catalog merged with the installed store, each with its enabled state (any authenticated actor)",
      },
    },
  );

/** Writes: cookie-admin only, exactly like `system-keys.route.ts` (bearer keys refused). */
const adminRoutes = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user }) => {
      if (!SAFE_PLUGIN_ID.test(body.pluginId)) {
        throw new HarnessStateError(`"${body.pluginId}" is not a valid plugin id`, 400);
      }
      let source: Static<typeof InstallSourceSchema> = "embedded";
      if (body.spec !== undefined) {
        // Validate SHAPE before any fetch spends anything (phase 3's rule):
        // a malformed npm spec is bad input naming itself, never a 500. This
        // validates shape only — whether the package exists, matches its
        // announced digest, or loads is the registry's and the loader's
        // answer, below.
        try {
          parsePackageSpec(body.spec);
        } catch (err) {
          throw new HarnessStateError(describe(err), 400);
        }
        source = "registry";
      } else if (!(await builtInIds()).includes(body.pluginId)) {
        // Without a spec the only bytes available are this binary's.
        // `installPlugin` would throw a bare Error the handler maps to 500;
        // an id this build cannot install is bad input.
        throw new HarnessStateError(`"${body.pluginId}" is not a plugin this build carries`, 400);
      }
      try {
        await installLocalPlugin(body.pluginId, body.spec, registryUrlOverride ?? SUBSHELL_PLUGIN_REGISTRY_URL);
      } catch (err) {
        if (err instanceof HarnessStateError) throw err;
        // Integrity, a claim collision, a failed load-check: the pane-runtime
        // message says which. The target declined the change — a 409, not a
        // 500 dressed as a server fault.
        throw new HarnessStateError(describe(err), 409);
      }
      // Audited AFTER the bytes landed: a line for a refused install would
      // record something that did not happen. Which PACKAGE the bytes came
      // from is the fact an operator audits, not just which id.
      await audit({
        actorUserId: user.id,
        action: "plugin.install",
        targetType: "plugin",
        targetId: body.pluginId,
        metadataJson: JSON.stringify({
          pluginId: body.pluginId,
          source,
          ...(body.spec !== undefined ? { spec: body.spec } : {}),
        }),
      });
      return await requireRow(body.pluginId, await readSources());
    },
    {
      body: InstallBodySchema,
      response: {
        200: PluginRowSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "installInstancePlugin",
        tags: ["plugins"],
        description:
          "Installs a plugin into the instance store (cookie admin). A `spec` fetches that npm package and its code then runs IN THIS PROCESS; absent, this build's embedded copy. Seeds every user a Default profile for the harness",
      },
    },
  )
  .patch(
    "/:pluginId",
    async ({ params, body, user }) => {
      if (!SAFE_PLUGIN_ID.test(params.pluginId)) {
        throw new HarnessStateError(`"${params.pluginId}" is not a valid plugin id`, 400);
      }
      const state = new PluginStateRepository(db);
      const s = await readSources();
      if (!s.installed.some((r) => r.id === params.pluginId)) {
        // The flag is a statement about an INSTALLED plugin; toggling one the
        // store does not hold would write a row nothing reads.
        throw new HttpError(404, `"${params.pluginId}" is not installed on this instance`);
      }
      const was = s.state.get(params.pluginId) !== false;
      // The row is written BOTH ways: an explicit enable is the operator's
      // recorded choice, and the absent-row default belongs to installs the
      // flag never touched.
      await state.setEnabled(params.pluginId, body.enabled);
      // A no-change repeat would land an audit row saying nothing happened —
      // the noise stays out of the one log an operator reconstructs from.
      if (was !== body.enabled) {
        await audit({
          actorUserId: user.id,
          action: body.enabled ? "plugin.enable" : "plugin.disable",
          targetType: "plugin",
          targetId: params.pluginId,
          metadataJson: JSON.stringify({ pluginId: params.pluginId }),
        });
      }
      return await requireRow(params.pluginId, await readSources());
    },
    {
      params: PARAMS,
      body: PatchBodySchema,
      response: {
        200: PluginRowSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setInstancePluginEnabled",
        tags: ["plugins"],
        description:
          "Enables or disables an installed plugin (cookie admin). Disabling hides its profiles everywhere and blocks its launches; nothing is stored per-profile, so re-enabling brings the same rows back",
      },
    },
  )
  .get(
    "/:pluginId/impact",
    async ({ params }) => {
      if (!SAFE_PLUGIN_ID.test(params.pluginId)) {
        throw new HarnessStateError(`"${params.pluginId}" is not a valid plugin id`, 400);
      }
      const rows = await new ProfilesRepository(db).listByHarness(params.pluginId);
      return {
        profiles: rows.length,
        // Distinct OWNERS, counting every user who owns one of these profiles
        // including the caller — the `N` in the dialog's "M profiles use it,
        // across N users". A foreign-profile count could not say that number
        // (three others' profiles are one teammate or three, and the dialog
        // names users, not profiles).
        distinctUsers: new Set(rows.map((r) => r.userId)).size,
        defaults: rows.filter((r) => r.isDefault === 1).length,
        runningSubshells: await new SubshellsRepository(db).countRunningByHarness(params.pluginId),
      };
    },
    {
      params: PARAMS,
      response: {
        200: ImpactResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "getInstancePluginImpact",
        tags: ["plugins"],
        description:
          "The blast radius an uninstall would have: profiles, other users' share, Defaults, running subshells",
      },
    },
  )
  .delete(
    "/:pluginId",
    async ({ params, query, user }) => {
      const mode = query.mode ?? "keep";
      if (!SAFE_PLUGIN_ID.test(params.pluginId)) {
        throw new HarnessStateError(`"${params.pluginId}" is not a valid plugin id`, 400);
      }
      // Bytes first: a failed uninstall must not have already deleted
      // profiles for a plugin that stayed installed. `uninstallLocalPlugin`
      // also clears the enable-flag row, so a later reinstall starts enabled
      // — "installing writes nothing, the default is on" only means
      // something if the uninstall took the old opinion with it.
      const removedBytes = await uninstallLocalPlugin(params.pluginId);
      let profilesRemoved = 0;
      if (mode === "delete") {
        // THE one sanctioned bypass of the Default-profile guard: a Default
        // for a harness that no longer exists is meaningless, and leaving it
        // would be the one row its owner cannot remove (spec §6.1). The
        // per-profile `DELETE /api/profiles/:id` guard stays as written.
        profilesRemoved = await new ProfilesRepository(db).deleteByHarness(params.pluginId);
      }
      // An already-absent plugin with nothing using it is the state the
      // caller asked for — 200, and NO audit line for a change that did not
      // happen.
      if (removedBytes || profilesRemoved > 0) {
        await audit({
          actorUserId: user.id,
          action: "plugin.uninstall",
          targetType: "plugin",
          targetId: params.pluginId,
          metadataJson: JSON.stringify({ pluginId: params.pluginId, mode, profilesRemoved }),
        });
      }
      return { ok: true, mode, profilesRemoved } as const;
    },
    {
      params: PARAMS,
      query: t.Object({
        mode: t.Optional(
          t.Union([t.Literal("keep"), t.Literal("delete")], {
            description:
              "'keep' (default): bytes only, profiles survive hidden until reinstalled. 'delete': also removes every profile using this harness, across every user, Defaults included. Running subshells are untouched either way",
          }),
        ),
      }),
      response: {
        200: DeleteResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "uninstallInstancePlugin",
        tags: ["plugins"],
        description:
          "Uninstalls a plugin from the instance store (cookie admin). Default mode `keep` never touches profiles; `delete` sweeps them including Defaults. A plugin already absent succeeds",
      },
    },
  );

export const pluginsRoutes = new Elysia({ prefix: "/api/plugins" })
  // GET is any authenticated actor; the write half composes `requireAdmin`
  // as its own route-bearing sub-instance, mirroring `users.route.ts`
  // (authGuard for the reads, then a stricter gate per verb — one prefix,
  // two doors, neither the weaker door for the other's operation).
  .use(readRoutes)
  .use(adminRoutes);
