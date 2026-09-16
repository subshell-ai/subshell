import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  builtInHarnesses,
  builtInIds,
  getBuiltInHarness,
  getHarness,
  PLUGIN_TYPES,
  type PluginType,
  parsePackageSpec,
  readBuiltIn,
} from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { Elysia, type Static, t } from "elysia";
import { authGuard, HttpError, requireAdmin } from "@/api/auth-guard.js";
import { HarnessStateError } from "@/api/harness-utils.js";
import { IS_TEST, SUBSHELL_PLUGIN_REGISTRY_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import {
  installLocalPlugin,
  localPluginReports,
  localPluginsDir,
  uninstallLocalPlugin,
} from "@/services/nodes/local-plugins.js";

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
 * other people's presets use ASKS first (the impact endpoint feeds the
 * dialog), and `mode=delete` sweeps those presets too — every one of them is
 * real customisation now (the seeded Default is gone, spec 2026-09-13), and
 * subshells that used a swept preset survive presetless.
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

/**
 * A plugin type this build knows, or undefined.
 *
 * The wire carries manifest data verbatim, so a value from a plugin built
 * against a later contract can be a type this binary has never heard of.
 * Naming the known set in one place is what keeps the fallback below a
 * decision rather than an accident.
 */
function pluginTypeOf(value: string | undefined): PluginType | undefined {
  return value !== undefined && (PLUGIN_TYPES as readonly string[]).includes(value) ? (value as PluginType) : undefined;
}

/** One plugin as the instance page renders it: identity × installed × enabled. */
const PluginRowSchema = t.Object({
  id: t.String({ description: "Plugin id (its directory name under the instance's plugins dir)" }),
  name: t.String({ description: "Display name, from the installed plugin or this build's manifest" }),
  type: t.Union([t.Literal("agent-harness"), t.Literal("terminal"), t.Literal("network")], {
    description:
      "Manifest plugin type: an agent CLI, a plain shell, or a network this host can be reached over. The web Agent picker takes `agent-harness` only; `network` rows are managed from Settings → Networking",
  }),
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
      "Offer the plugin (true) or hold its bytes without offering them (false). Presets are never touched in either direction",
  }),
});

const ImpactResponseSchema = t.Object({
  presets: t.Number({ description: "Presets using this harness, across every user" }),
  distinctUsers: t.Number({
    description:
      "Every user who owns one of these presets, the caller included — the 'across N users' count the uninstall dialog renders",
  }),
  runningSubshells: t.Number({ description: "RUNNING subshells on this harness. Uninstalling touches none of them" }),
});

const DeleteResponseSchema = t.Object({
  ok: t.Boolean({ description: "Always true on success; an already-absent plugin is the state the caller asked for" }),
  mode: t.Union([t.Literal("keep"), t.Literal("delete")], {
    description: "The mode the uninstall ran in (defaults to keep)",
  }),
  presetsRemoved: t.Number({ description: "Presets deleted (0 for keep, and 0 for a plugin nothing used)" }),
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
    // The manifest's type, whichever source knows this id. The wire type is a
    // plain string (manifest data, not re-validated here), so an unknown value
    // has to become SOMETHING — and it must not become `agent-harness`, which
    // is what this did while there were only two types. A network plugin
    // mislabelled that way lands in the launch picker, which is the one place
    // the type genuinely gates rather than merely labels. `terminal` is the
    // safe fallback: it is a harness type, so nothing that reads this row
    // breaks, and it is last in every picker's default rule.
    type: pluginTypeOf(report?.type) ?? harness?.type ?? "terminal",
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

/**
 * Content types for the extensions {@link ICON_EXTENSIONS} admits. Mapped from
 * the NAME and never sniffed from the bytes: the bytes are a third party's,
 * so a type derived from them is a type the plugin chose.
 */
const ICON_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * One plugin's icon bytes, or undefined when it declares none, ships none, or
 * is not a plugin this instance knows.
 *
 * Two sources, disk first: `<pluginsDir>/<id>/<icon>` covers a
 * registry-installed plugin AND a built-in (boot seeds those to the same
 * place), and `readBuiltIn` is the fallback for the window before a seed has
 * run. Both are the same file; the ladder is about availability, not about
 * two kinds of plugin.
 */
async function readPluginIcon(id: string): Promise<{ body: Uint8Array; type: string } | undefined> {
  if (!SAFE_PLUGIN_ID.test(id)) return undefined;
  const rel = getHarness(id)?.icon;
  if (!rel) return undefined;
  const type = ICON_TYPES[extname(rel).toLowerCase()];
  // An extension `parseManifest` admits but this table does not is a bug in
  // one of the two lists, and serving it as something guessed is the wrong
  // way to find out.
  if (!type) return undefined;

  const dir = join(localPluginsDir(), id);
  const path = resolve(dir, rel);
  // `parseManifest` already refuses a leading `/` and any `..` segment. This
  // re-checks the RESOLVED path, the way the plugin loader re-checks `entry`:
  // the manifest on disk is a third party's file, and one gate that runs
  // where the path is USED is worth more than trusting the one upstream.
  if (path !== dir && !path.startsWith(`${dir}/`)) return undefined;

  try {
    return { body: new Uint8Array(await readFile(path)), type };
  } catch {
    // Not seeded yet, or a plugin that declares an icon it does not ship.
  }
  const source = await readBuiltIn(id);
  const embedded = source?.files[rel];
  if (embedded === undefined) return undefined;
  return { body: typeof embedded === "string" ? new TextEncoder().encode(embedded) : embedded, type };
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
  )
  .get(
    "/:pluginId/icon",
    async ({ params, set }) => {
      const bytes = await readPluginIcon(params.pluginId);
      if (!bytes) throw new HttpError(404, `"${params.pluginId}" has no icon`);
      set.headers["content-type"] = bytes.type;
      // The bytes are a PLUGIN's, and a third party's SVG served from this
      // origin would otherwise be a scripting context on the origin holding
      // the session cookie — for anyone who opens the URL directly, not in
      // the `<img>` the UI renders. `sandbox` with no allow-list is what
      // makes that document inert; `nosniff` is what stops the declared type
      // being second-guessed from content the plugin chose.
      set.headers["content-security-policy"] = "default-src 'none'; sandbox";
      set.headers["x-content-type-options"] = "nosniff";
      // Immutable for a day rather than forever: a plugin UPGRADE can change
      // the icon behind an unchanged URL, and a day is short enough that an
      // upgrade shows up on its own without a cache-busting query.
      set.headers["cache-control"] = "private, max-age=86400";
      return new Response(bytes.body);
    },
    {
      params: t.Object({ pluginId: t.String({ description: "Plugin id" }) }),
      detail: {
        operationId: "getPluginIcon",
        tags: ["plugins"],
        description: "This plugin's icon image, as declared by its manifest (any authenticated actor)",
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
          "Installs a plugin into the instance store (cookie admin). A `spec` fetches that npm package and its code then runs IN THIS PROCESS; absent, this build's embedded copy",
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
          "Enables or disables an installed plugin (cookie admin). Disabling hides its presets everywhere and blocks its launches; nothing is stored per-preset, so re-enabling brings the same rows back",
      },
    },
  )
  .get(
    "/:pluginId/impact",
    async ({ params }) => {
      if (!SAFE_PLUGIN_ID.test(params.pluginId)) {
        throw new HarnessStateError(`"${params.pluginId}" is not a valid plugin id`, 400);
      }
      const rows = await new PresetsRepository(db).listByHarness(params.pluginId);
      return {
        presets: rows.length,
        // Distinct OWNERS, counting every user who owns one of these presets
        // including the caller — the `N` in the dialog's "M presets use it,
        // across N users". A foreign-preset count could not say that number
        // (three others' presets are one teammate or three, and the dialog
        // names users, not presets).
        distinctUsers: new Set(rows.map((r) => r.userId)).size,
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
        description: "The blast radius an uninstall would have: presets, other users' share, running subshells",
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
      // presets for a plugin that stayed installed. `uninstallLocalPlugin`
      // also clears the enable-flag row, so a later reinstall starts enabled
      // — "installing writes nothing, the default is on" only means
      // something if the uninstall took the old opinion with it.
      const removedBytes = await uninstallLocalPlugin(params.pluginId);
      let presetsRemoved = 0;
      if (mode === "delete") {
        // Every swept row is customisation someone made — the seeded Default
        // is gone (spec 2026-09-13) — and subshells that used one survive as
        // presetless launches (`PresetsRepository.deleteByHarness` nulls the
        // references; spec §6).
        presetsRemoved = await new PresetsRepository(db).deleteByHarness(params.pluginId);
      }
      // An already-absent plugin with nothing using it is the state the
      // caller asked for — 200, and NO audit line for a change that did not
      // happen.
      if (removedBytes || presetsRemoved > 0) {
        await audit({
          actorUserId: user.id,
          action: "plugin.uninstall",
          targetType: "plugin",
          targetId: params.pluginId,
          metadataJson: JSON.stringify({ pluginId: params.pluginId, mode, presetsRemoved }),
        });
      }
      return { ok: true, mode, presetsRemoved } as const;
    },
    {
      params: PARAMS,
      query: t.Object({
        mode: t.Optional(
          t.Union([t.Literal("keep"), t.Literal("delete")], {
            description:
              "'keep' (default): bytes only, presets survive hidden until reinstalled. 'delete': also removes every preset using this harness, across every user. Running subshells are untouched either way",
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
          "Uninstalls a plugin from the instance store (cookie admin). Default mode `keep` never touches presets; `delete` sweeps them. A plugin already absent succeeds",
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
