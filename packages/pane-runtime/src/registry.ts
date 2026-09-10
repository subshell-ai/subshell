import { join } from "node:path";
import type { PluginFactory, SubshellManifest } from "@subshell-ai/plugin-api";
import claudeCodeFactory, { manifest as claudeCodeManifest } from "@subshell-ai/plugin-claude-code";
import codexFactory, { manifest as codexManifest } from "@subshell-ai/plugin-codex";
import hermesFactory, { manifest as hermesManifest } from "@subshell-ai/plugin-hermes";
import opencodeFactory, { manifest as opencodeManifest } from "@subshell-ai/plugin-opencode";
import piFactory, { manifest as piManifest } from "@subshell-ai/plugin-pi";
import { adaptPlugin } from "./plugin-adapter.js";
import { createPluginHost } from "./plugin-host.js";
import { createInProcessRuntime } from "./plugin-runtime.js";
import { listInstalled, pluginsDir, readInstallRecord } from "./plugins-dir.js";
import type { HarnessPlugin } from "./types.js";

/**
 * The plugins this build ships with.
 *
 * Built-ins are imported STATICALLY, not through the disk loader, because
 * they live inside the binary: `bun build --compile` has to see them, and a
 * user must be able to run a harness on a machine with no network. The loader
 * (`plugin-runtime.ts`) is for plugins installed at runtime, which is a
 * different problem with a different answer.
 *
 * **Construction is lazy and contained**, per `.claude/rules/code-style.md`
 * ("Construct lazily, never at import"). Building the list at module scope
 * would run five factories during the evaluation of anything that imports
 * this, so one plugin throwing would take `subshell-server` and `subshell`
 * down at boot rather than being reported and skipped. That is the same fault
 * boundary the disk loader gives, and there is no reason a built-in should
 * have a weaker one.
 *
 * What this canNOT contain is a plugin module that throws while being
 * IMPORTED, since a static import is evaluated before any code here runs.
 * That is a build-time invariant instead: each plugin's `manifest.ts` throws
 * on a malformed `subshell` block, and each plugin's own test suite fails if
 * it ever is. A malformed manifest therefore cannot reach a release.
 */

/** One plugin compiled into this build. */
interface BuiltIn {
  manifest: SubshellManifest;
  factory: PluginFactory;
}

const BUILT_INS: BuiltIn[] = [
  { manifest: claudeCodeManifest, factory: claudeCodeFactory },
  { manifest: opencodeManifest, factory: opencodeFactory },
  { manifest: hermesManifest, factory: hermesFactory },
  { manifest: piManifest, factory: piFactory },
  { manifest: codexManifest, factory: codexFactory },
];

/** Ids compiled into this build. The shadowing rule keys off exactly this set. */
const BUILT_IN_IDS = new Set(BUILT_INS.map((b) => b.manifest.id));

/** A built-in whose factory threw. Reported, never fatal. */
export interface BrokenBuiltIn {
  /** Plugin id, from the manifest that parsed before the factory ran */
  id: string;
  /** What the factory threw */
  error: string;
}

interface Registry {
  plugins: HarnessPlugin[];
  broken: BrokenBuiltIn[];
}

let memo: Registry | null = null;

function build(): Registry {
  const plugins: HarnessPlugin[] = [];
  const broken: BrokenBuiltIn[] = [];
  for (const { manifest, factory } of BUILT_INS) {
    try {
      plugins.push(adaptPlugin(manifest, factory(createPluginHost({ pluginId: manifest.id }))));
    } catch (err) {
      // One bad plugin costs its own row, never the whole registry. It is
      // also LOGGED, not just recorded: a built-in that vanishes from every
      // list with nothing anywhere saying why is the anonymous failure this
      // is supposed to prevent, and `brokenBuiltIns()` alone does not reach
      // an operator.
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`subshell: built-in plugin "${manifest.id}" failed to construct and is unavailable: ${error}`);
      broken.push({ id: manifest.id, error });
    }
  }
  return { plugins, broken };
}

function registry(): Registry {
  memo ??= build();
  return memo;
}

/* ------------------------------------------------------------------ */
/* the installed overlay (spec 2026-09-10, Task 9b)                     */
/* ------------------------------------------------------------------ */

/**
 * The disk-resident plugins, resolved.
 *
 * The gap this closes: since Task 9 the control plane is the one plugin host,
 * `plugins.route.ts` sells installs, and `plugin-report.ts` loads each
 * installed package to describe it and then DISCARDS the result. Every
 * launch-path lookup (`detectSpecs`, profile validation, argv building)
 * keyed off `BUILT_INS`, which has no registration path — so a third-party
 * plugin listed, toggled and uninstalled but could never resolve, detect or
 * launch. The overlay is that registration path: `refreshInstalledPlugins`
 * loads each installed plugin through the SAME runtime and adapter the
 * built-ins go through, and `getHarness`/`allHarnesses` answer from
 * built-ins ∪ overlay.
 *
 * It is module state, deliberately, and the sync signatures survive on it.
 * Roughly ten call sites across the server read the registry synchronously;
 * the alternative — a `dataDir` parameter through all of them plus async —
 * would have made the agent, which holds no plugins at all (Task 7), carry
 * the concept too. **The agent safety is structural**: nothing in the agent
 * calls `refreshInstalledPlugins`, so its overlay stays empty and its reads
 * are built-in-only, exactly as before this existed.
 *
 * The overlay is replaced wholesale by a refresh (never mutated in place), so
 * two overlapping refreshes cannot interleave partial state — whoever writes
 * last describes a COMPLETE load pass.
 */
interface InstalledOverlay {
  /** `id -> adapted plugin` for successfully loaded installed non-built-ins */
  plugins: Map<string, HarnessPlugin>;
}

/** Why an installed plugin did not resolve. */
export interface BrokenInstalled {
  /** Plugin id (its directory name, which uninstall works by) */
  id: string;
  /** What the loader reported */
  error: string;
}

/** The result of one {@link refreshInstalledPlugins} pass. */
export interface InstalledRefresh {
  /** Ids that resolved into the overlay */
  loaded: string[];
  /** Ids that will not, with why. The result IS the read path for broken
   * state: callers log it or render it; the overlay keeps no second copy to
   * drift. */
  broken: BrokenInstalled[];
}

const EMPTY_OVERLAY: InstalledOverlay = { plugins: new Map() };

let overlay: InstalledOverlay = EMPTY_OVERLAY;

/** Memoized built-ins ∪ overlay; invalidated by every overlay or memo change. */
let merged: HarnessPlugin[] | null = null;

/** Shadowed ids already warned about, so the warning is once per process, not once per refresh. */
const shadowWarned = new Set<string>();

/**
 * Rebuild the overlay from `<dataDir>/plugins/`.
 *
 * Fault containment is the whole design, and it mirrors the built-ins'
 * exactly: an installed plugin that will not load becomes a `broken` entry
 * and costs itself alone — never the healthy installs beside it, never the
 * compiled set, never the caller. The loader already wraps import, factory
 * and capability checks; everything else here (directory listing, record
 * reads) swallows its own failures the same way `listInstalled` does.
 *
 * **Built-in shadowing:** when an installed directory carries a built-in's
 * id, the COMPILED copy wins and the directory is never loaded. An embedded
 * copy (no `install.json` sidecar — the installer writes that only for
 * registry fetches) is the ordinary seeded state, so it stays silent; a
 * REGISTRY package claiming the id is the case an operator should hear
 * about, and it is warned about ONCE per id per process.
 * @param dataDir - the host's data dir (the control plane passes its own;
 * no other caller exists, and must not)
 */
export async function refreshInstalledPlugins(dataDir: string): Promise<InstalledRefresh> {
  const runtime = createInProcessRuntime();
  const plugins = new Map<string, HarnessPlugin>();
  const broken: BrokenInstalled[] = [];

  for (const installed of await listInstalled(dataDir)) {
    if (installed.broken) {
      broken.push({ id: installed.id, error: installed.broken });
      continue;
    }
    if (BUILT_IN_IDS.has(installed.id)) {
      // A registry install squatting a built-in id deserves a name in the
      // log; the build's own seeded copy, which refreshes into this same
      // directory on every boot, does not deserve five warnings a restart.
      if ((await readInstallRecord(dataDir, installed.id)) && !shadowWarned.has(installed.id)) {
        shadowWarned.add(installed.id);
        console.warn(
          `subshell: an installed package claims plugin id "${installed.id}", which this build compiles in; ` +
            "the shadowed install is not loaded, the compiled copy answers every launch",
        );
      }
      continue;
    }
    const loaded = await runtime.load(join(pluginsDir(dataDir), installed.id));
    if ("error" in loaded) {
      broken.push({ id: installed.id, error: loaded.error });
      continue;
    }
    plugins.set(loaded.manifest.id, adaptPlugin(loaded.manifest, loaded.plugin));
  }

  // The broken rows reach the caller ONLY: the result is the single read
  // path, and keeping a second copy here is what the removed getter used to
  // risk drifting from it.
  overlay = { plugins };
  merged = null;
  return { loaded: [...plugins.keys()], broken };
}

/**
 * Empties the overlay. For tests, and for a host shutting a plugin store
 * down. Does not touch the built-in memo, and cannot un-import modules the
 * runtime cache holds (same caveat as `plugin-runtime.ts`'s `IMPORTED`).
 * @internal
 */
export function clearInstalledPlugins(): void {
  overlay = EMPTY_OVERLAY;
  merged = null;
  shadowWarned.clear();
}

/** Built-ins, plus any installed plugin the overlay resolved (stable identity). */
function mergedPlugins(): HarnessPlugin[] {
  const base = registry().plugins;
  if (overlay.plugins.size === 0) return base;
  merged ??= [...base, ...[...overlay.plugins.values()].filter((p) => !base.some((b) => b.id === p.id))];
  return merged;
}

/** Every resolvable plugin: the built-ins that constructed, plus the overlay. */
export function allHarnesses(): HarnessPlugin[] {
  return mergedPlugins();
}

/** One plugin by id, or undefined. Built-ins answer first: the shadow rule. */
export function getHarness(id: string): HarnessPlugin | undefined {
  return registry().plugins.find((h) => h.id === id) ?? overlay.plugins.get(id);
}

/**
 * Every plugin COMPILED INTO THIS BUILD that constructed successfully.
 *
 * The pre-overlay meaning of `allHarnesses()`, kept whole for its two honest
 * uses ("what can this binary install offline", the setup wizard and the
 * instance page's catalog region). Neither question is about what is
 * INSTALLED, and once the overlay exists only this function can answer them
 * without also listing what somebody installed from a registry.
 */
export function builtInHarnesses(): HarnessPlugin[] {
  return registry().plugins;
}

/** Whether one id is compiled into this build, independent of anything installed. */
export function getBuiltInHarness(id: string): HarnessPlugin | undefined {
  return registry().plugins.find((h) => h.id === id);
}

/**
 * Built-ins whose factory threw.
 *
 * Empty in every shipped build (a factory that throws fails that plugin's own
 * tests), and surfaced so a broken one is diagnosable rather than merely absent
 * from a list.
 */
export function brokenBuiltIns(): BrokenBuiltIn[] {
  return registry().broken;
}

/**
 * Drops the memoized built-ins. For tests that stub a plugin.
 * @internal
 */
export function resetRegistryForTests(): void {
  memo = null;
  merged = null;
}
