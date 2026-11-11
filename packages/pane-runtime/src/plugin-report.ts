import { join } from "node:path";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { isHarnessType, type SubshellPlugin } from "@subshell-ai/plugin-api";
import { readBuiltIn } from "./builtin-source.js";
import { createInProcessRuntime, type LoadedPlugin, type PluginRuntime } from "./plugin-runtime.js";
import { bundledPluginVersion, installedCopyWins } from "./plugin-versions.js";
import {
  type InstalledPlugin,
  type InstallRecord,
  listInstalled,
  pluginsDir,
  readInstallRecord,
} from "./plugins-dir.js";
import { brokenBuiltIns, builtInNetworkPlugins, getBuiltInHarness } from "./registry.js";
import type { HarnessPlugin, McpLaunchSpec, ReporterSpec } from "./types.js";

/**
 * Describing this node's plugins to the control plane.
 *
 * The server holds no plugin code for a machine it does not run on, so
 * everything it needs about a plugin travels as DATA: enough to list it,
 * render its preset editor, label its exit codes and explain its MCP setup.
 *
 * A plugin that will not load still gets a row, carrying `broken`. Dropping it
 * would make a misconfigured plugin indistinguishable from one nobody
 * installed, and the node page has to be able to tell a user which of those
 * they are looking at.
 *
 * **A built-in's row describes the copy that actually answers.** Its bytes are
 * compiled into this build, so the directory on disk is the effective copy
 * only when it is strictly newer than the bundle AND loads. Otherwise the
 * bundle answers and the disk copy rides along as `shadowed` — including the
 * error when a newer copy failed to load. The losing copy is never imported:
 * version and manifest decide, and both are read without executing anything,
 * because importing a copy that lost would run its code in this process for
 * the rest of the process's life.
 */

/**
 * The exit codes worth asking a plugin about.
 *
 * `exitStatus` is a lookup rather than an enumeration, so there is no way to
 * ask a plugin which codes it names. This range covers the codes the built-ins
 * actually use plus the shell's signal encodings, and an unmapped code simply
 * does not appear.
 */
const EXIT_CODES = [...Array(21).keys(), 124, 125, 126, 127, 128, 130, 137, 143];

/**
 * The launch specs manual setup text is rendered against.
 *
 * The launch spec is the SERVER's to resolve, so the setup text here is
 * rendered against a placeholder the server substitutes. Plugins that
 * describe manual steps embed the command, which is why this is reported at
 * all rather than recomputed on the control plane.
 *
 * This literal intentionally mirrors `PORTABLE_MCP_LAUNCH` in
 * `apps/server/api/src/modules/subshells/mcp-resolve.ts` — the same PATH
 * spelling the preset editor shows (issue #57). Spelled twice on purpose:
 * importing the server's constant here would breach the type-only licence
 * carve-out, so `plugin-report.test.ts` pins both sides to the same literal
 * instead.
 */
const PORTABLE_MCP_LAUNCH: McpLaunchSpec = { command: "subshell", args: ["mcp"] };
const PORTABLE_REPORTER: ReporterSpec = { command: "subshell", args: ["report"] };

/** Where the bytes of the copy a row describes came from. */
type PluginSource = NonNullable<PluginReportWire["source"]>;

/** The disk copy a row must name when that copy is not the one in use. */
type ShadowedCopy = NonNullable<PluginReportWire["shadowed"]>;

/**
 * The manifest-shaped fields every row carries.
 *
 * Deliberately no `version`: which version the row states is the precedence
 * decision, not something an identity answers.
 */
interface ReportIdentity {
  id: string;
  name: string;
  type: string;
  icon?: string;
  description: string;
  pickable?: false;
}

/**
 * Where a row's identity may be read from: a manifest, or the adapted plugin.
 *
 * `pickable` is plain `boolean` here because a manifest declares it that way;
 * only `false` travels to the wire (see `identity`), so the row's own field
 * stays narrow.
 */
interface IdentitySource extends Omit<ReportIdentity, "pickable"> {
  pickable?: boolean;
}

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copies identity fields, omitting absent ones rather than sending `undefined`. */
function identity(from: IdentitySource): ReportIdentity {
  return {
    id: from.id,
    name: from.name,
    type: from.type,
    ...(from.icon ? { icon: from.icon } : {}),
    description: from.description,
    ...(from.pickable === false ? { pickable: false as const } : {}),
  };
}

/** The labels a harness gives the exit codes worth asking about. */
function exitStatusesOf(exitStatus: ((code: number) => string | null) | undefined): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const code of EXIT_CODES) {
    const label = exitStatus?.(code);
    if (label) statuses[String(code)] = label;
  }
  return statuses;
}

/** Extra facts a broken row may carry beside its reason. */
interface BrokenExtras {
  /** The disk copy that would have answered if it could */
  shadowed?: ShadowedCopy;
  /** A stale load: a newer copy is on disk, and a restart is the remedy */
  restartRequired?: boolean;
}

/**
 * A row for something that cannot answer: named by its manifest, carrying why.
 *
 * `capabilities` is empty rather than absent because the wire field is
 * required, and a broken plugin has answered nothing.
 */
function brokenRow(
  from: IdentitySource,
  version: string,
  source: PluginSource,
  broken: string,
  extras: BrokenExtras = {},
): PluginReportWire {
  return {
    ...identity(from),
    version,
    capabilities: [],
    broken,
    source,
    ...(extras.restartRequired ? { restartRequired: true } : {}),
    ...(extras.shadowed ? { shadowed: extras.shadowed } : {}),
  };
}

/**
 * The row for a loaded copy on disk: the one that won.
 *
 * `id`, `name`, `type`, `icon` and `description` come from the manifest, so
 * they describe the copy on DISK. Everything else was answered by the loaded
 * plugin, so on a stale load those are the OLD build's capabilities, settings
 * schemas and MCP steps being reported under the new version's number — which
 * is exactly what `restartRequired` says.
 */
function loadedRow(loaded: LoadedPlugin, version: string, source: PluginSource): PluginReportWire {
  const { manifest } = loaded;
  try {
    // A network plugin has none of the launch-shaped members below, and
    // asking it for them would report empty arrays as if it had answered.
    // The manifest type is what decides, here as everywhere: the loader has
    // already proved the object matches it.
    const harness = isHarnessType(manifest.type) ? (loaded.plugin as SubshellPlugin) : null;
    const exitStatuses = exitStatusesOf(harness?.exitStatus?.bind(harness));
    return {
      ...identity(manifest),
      version,
      capabilities: loaded.plugin.capabilities(),
      ...(harness
        ? {
            presetSettings: harness.presetSettings?.() ?? [],
            suggestedEnv: harness.suggestedEnv?.() ?? [],
            suggestedFlags: harness.suggestedFlags?.() ?? [],
            mcpSetup: harness.mcpSetup?.(PORTABLE_MCP_LAUNCH, PORTABLE_REPORTER),
          }
        : {}),
      ...(Object.keys(exitStatuses).length > 0 ? { exitStatuses } : {}),
      source,
      ...(loaded.stale ? { restartRequired: true } : {}),
    };
  } catch (err) {
    return brokenRow(manifest, version, source, `the plugin threw while describing itself: ${describe(err)}`);
  }
}

/**
 * The row for the harness compiled into this build.
 *
 * Identity, capabilities, settings, setup text and exit labels all come from
 * the adapted plugin the launcher itself uses (`getBuiltInHarness`), never
 * from the directory on disk: a losing disk copy could name a different
 * description or a narrower capability set, and the row must describe the code
 * that will run.
 */
function compiledHarnessRow(
  harness: HarnessPlugin,
  version: string,
  shadowed: ShadowedCopy | undefined,
): PluginReportWire {
  const exitStatuses = exitStatusesOf((code) => harness.exitStatus?.(code) ?? null);
  return {
    ...identity(harness),
    version,
    // The compiled copy's bytes are this build's, always: a sidecar on disk
    // describes the copy that LOST, and that is `shadowed.source`.
    source: "build",
    capabilities: harness.capabilities(),
    presetSettings: harness.settingsFields(),
    suggestedEnv: harness.suggestedEnv(),
    suggestedFlags: harness.suggestedFlags(),
    mcpSetup: harness.mcpSetup(PORTABLE_MCP_LAUNCH, PORTABLE_REPORTER),
    ...(Object.keys(exitStatuses).length > 0 ? { exitStatuses } : {}),
    ...(shadowed ? { shadowed } : {}),
  };
}

/**
 * The row for the compiled copy of a built-in id.
 *
 * The registry is the source of both halves: an adapted harness, a network
 * plugin's manifest-plus-object, or — when the id exists but nothing
 * constructed — the factory's recorded refusal from `brokenBuiltIns`.
 */
function compiledRow(
  installed: InstalledPlugin,
  version: string,
  shadowed: ShadowedCopy | undefined,
): PluginReportWire {
  const harness = getBuiltInHarness(installed.id);
  const network = harness ? undefined : builtInNetworkPlugins().find((entry) => entry.manifest.id === installed.id);
  try {
    if (harness) return compiledHarnessRow(harness, version, shadowed);
    if (network) {
      return {
        ...identity(network.manifest),
        version,
        source: "build",
        capabilities: network.plugin.capabilities(),
        ...(shadowed ? { shadowed } : {}),
      };
    }
    // This build carries the plugin's FILES but the registry holds no object
    // for it: a factory that threw, or an embedded plugin no built-in entry
    // names. Nothing can run, and `broken` is the honest row either way.
    const error =
      brokenBuiltIns().find((built) => built.id === installed.id)?.error ??
      "this build carries the plugin's files but has no copy of the plugin to run";
    return brokenRow(installed.manifest, version, "build", error, { shadowed });
  } catch (err) {
    return brokenRow(
      installed.manifest,
      version,
      "build",
      `the plugin threw while describing itself: ${describe(err)}`,
      {
        shadowed,
      },
    );
  }
}

/**
 * The row for a built-in id: which copy answers, and whether the other one is
 * worth naming.
 *
 * The rule is one comparison plus, at most, one load. Only a STRICTLY newer
 * installed copy can win, and only if it loads: an equal version is already
 * the bundle's own bytes, and an older one would be a rollback nobody asked
 * for. A copy that lists as broken — unparseable manifest, or a plugin-api
 * this host does not implement — is decided without touching its code.
 */
async function builtInRow(
  runtime: PluginRuntime,
  dataDir: string,
  installed: InstalledPlugin,
  record: InstallRecord | null,
  diskSource: PluginSource,
): Promise<PluginReportWire> {
  const bundled = await bundledPluginVersion(installed.id);

  if (!installed.broken && bundled !== null && installedCopyWins(bundled, installed.version)) {
    const loaded = await runtime.load(join(pluginsDir(dataDir), installed.id));
    if (!("error" in loaded)) return loadedRow(loaded, installed.version, diskSource);
    // A newer copy that will not load has not won: the bundle answers, and the
    // failure rides on `shadowed`. An operator just upgraded INTO this, so a
    // healthy row would hide exactly what they need to see.
    return compiledRow(installed, bundled, { version: installed.version, source: diskSource, error: loaded.error });
  }

  // Silent on a healthy copy of the bundle's own, which is the state every
  // boot seeds. A broken copy, or one with a different version, is worth
  // naming — and the sidecar states the version when the manifest cannot.
  const shadowed: ShadowedCopy | undefined =
    installed.broken || installed.version !== bundled
      ? {
          version: record?.version ?? installed.version,
          source: diskSource,
          ...(installed.broken ? { error: installed.broken } : {}),
        }
      : undefined;
  return compiledRow(installed, bundled ?? "", shadowed);
}

/**
 * Builds one report per installed plugin, id-sorted.
 *
 * Never rejects: a plugin that throws on load or on any accessor becomes a
 * `broken` row, and a built-in whose installed copy loses still answers from
 * the compiled copy. One bad plugin must not cost the node its whole
 * inventory.
 * @param dataDir - the host's data dir
 */
export async function buildPluginReports(dataDir: string): Promise<PluginReportWire[]> {
  const runtime = createInProcessRuntime();
  const reports: PluginReportWire[] = [];

  for (const installed of await listInstalled(dataDir)) {
    const record = await readInstallRecord(dataDir, installed.id);
    // What a directory can claim about its own origin. `build` is a claim only
    // a built-in's directory can make — its bytes came from this build unless
    // a registry sidecar says otherwise — while a third-party directory with
    // no sidecar has no provable origin at all.
    const diskSource: PluginSource = record ? "npm" : "build";

    // A built-in id is decided by this build, not by what happens to be on
    // disk: the bundle carries bytes for it, so the copy that answers is
    // chosen here.
    if ((await readBuiltIn(installed.id)) !== null) {
      reports.push(await builtInRow(runtime, dataDir, installed, record, diskSource));
      continue;
    }

    const source: PluginSource = record ? "npm" : "unrecorded";
    if (installed.broken) {
      reports.push(brokenRow(installed.manifest, installed.version, source, installed.broken));
      continue;
    }

    const loaded = await runtime.load(join(pluginsDir(dataDir), installed.id));
    if ("error" in loaded) {
      reports.push(
        brokenRow(installed.manifest, installed.version, source, loaded.error, {
          restartRequired: loaded.stale === true,
        }),
      );
      continue;
    }
    reports.push(loadedRow(loaded, installed.version, source));
  }

  return reports;
}
