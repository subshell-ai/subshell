import type { PluginFactory, SubshellManifest } from "@subshell-ai/plugin-api";
import claudeCodeFactory, { manifest as claudeCodeManifest } from "@subshell-ai/plugin-claude-code";
import codexFactory, { manifest as codexManifest } from "@subshell-ai/plugin-codex";
import hermesFactory, { manifest as hermesManifest } from "@subshell-ai/plugin-hermes";
import opencodeFactory, { manifest as opencodeManifest } from "@subshell-ai/plugin-opencode";
import piFactory, { manifest as piManifest } from "@subshell-ai/plugin-pi";
import { adaptPlugin } from "./plugin-adapter.js";
import { createPluginHost } from "./plugin-host.js";
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

/** Every built-in plugin that constructed successfully. */
export function allHarnesses(): HarnessPlugin[] {
  return registry().plugins;
}

/** One plugin by id, or undefined. */
export function getHarness(id: string): HarnessPlugin | undefined {
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
 * Drops the memoized registry. For tests that stub a plugin.
 * @internal
 */
export function resetRegistryForTests(): void {
  memo = null;
}
