import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  capabilityMismatches,
  parseManifest,
  type SubshellManifest,
  type SubshellPlugin,
} from "@subshell-ai/plugin-api";
import { createPluginHost } from "./plugin-host.js";

/**
 * Loading a plugin from disk.
 *
 * **This is the one file in the repo permitted to `await import()`.**
 * `.claude/rules/code-style.md` bans it because `bun build --compile` cannot
 * see through it and drops the target from the binary. Here that is the
 * mechanism rather than the bug: the target is a plugin the user installed
 * AFTER the binary was built, and it must not be bundled into it.
 *
 * Measured on bun 1.4.2, and all three findings shape this file:
 *
 * - a compiled binary can `import()` an absolute path at runtime, and the
 *   loaded module can call back into an object passed as an argument;
 * - it cannot resolve a bare specifier of ours, which is why the host object
 *   exists at all (`plugin-host.ts`);
 * - a top-level `throw` IS fully contained by `try/catch` around the import,
 *   which is what makes the in-process runtime defensible.
 *
 * What it does NOT do is sandbox: a plugin has `node:fs` and the agent's own
 * privileges. See `docs/security.md`. The {@link PluginRuntime} interface
 * exists so that moving to a Worker per plugin later is one class rather than
 * a rewrite.
 */

/** A plugin that loaded and is ready to use. */
export interface LoadedPlugin {
  manifest: SubshellManifest;
  plugin: SubshellPlugin;
  /**
   * The entry file changed since THIS PROCESS first imported it, so `plugin`
   * is the previously loaded code while `manifest` is what is on disk now.
   *
   * Absent on every ordinary load. Present after an upgrade in place, and it
   * cannot be repaired from here — see {@link IMPORTED}. A caller that shows
   * a version has to say a restart is pending, or it shows the new number
   * beside the old behaviour.
   */
  stale?: true;
}

/**
 * A plugin that did not load.
 *
 * `manifest` is present whenever the package.json parsed, even though the
 * module then failed, so a broken plugin can be NAMED on screen instead of
 * appearing as an anonymous failure in a directory listing.
 */
export interface BrokenPlugin {
  manifest: SubshellManifest | null;
  error: string;
}

/** Options for one load. */
export interface LoadOptions {
  /**
   * Overrides `manifest.entry`. TESTS ONLY, and it exists to exercise the
   * resolved-path containment check with a value the manifest parser would
   * itself reject.
   * @internal
   */
  entryOverrideForTests?: string;
}

/** How plugins are loaded. One implementation today; see the module docstring. */
export interface PluginRuntime {
  /**
   * Loads the plugin in `dir`.
   * @param dir - absolute path of the plugin's package directory
   * @returns the loaded plugin, or why it is broken. Never rejects.
   */
  load(dir: string, options?: LoadOptions): Promise<LoadedPlugin | BrokenPlugin>;
}

/**
 * Entry paths this process has imported, and what the file looked like then.
 *
 * **The ESM module cache cannot be evicted, so an upgrade in place does not
 * take effect until the agent restarts.** Measured on bun 1.4.2, against a
 * file overwritten between two imports: a `?v=` query, a `#` fragment and a
 * freshly named symlink all return the CACHED module (a symlink resolves to
 * its realpath, and the query/fragment are dropped from the cache key, unlike
 * Node), and `Loader.registry` is not exposed. Only a genuinely different real
 * path loads new code.
 *
 * Copying each plugin to a per-install path would buy the reload, at the price
 * of moving `import.meta.dir` out from under the plugin and making
 * `<dataDir>/plugins/<id>/` no longer the thing that runs. So the staleness is
 * REPORTED instead: the daemon is service-managed and comes back with its
 * panes intact, which makes "restart to finish the upgrade" a remedy rather
 * than a dead end.
 *
 * Keyed by resolved entry path, valued by mtime and size — a pair, because a
 * filesystem with second-granularity timestamps can reproduce an mtime within
 * one second of an install.
 */
const IMPORTED = new Map<string, string>();

/**
 * Forgets which entry paths have been imported.
 *
 * Only for tests: the real cache is the runtime's own and cannot be cleared,
 * so this makes the DETECTION testable, never the reload.
 * @internal
 */
export function resetImportedForTests(): void {
  IMPORTED.clear();
}

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a file looks like right now, for comparison against a past import. */
async function fingerprint(path: string): Promise<string> {
  const s = await stat(path);
  return `${s.mtimeMs}:${s.size}`;
}

/**
 * The in-process runtime: plugins share the host's process.
 *
 * Every entry point is wrapped, so one broken plugin is reported and skipped
 * rather than taking the caller down with it. That is the same containment
 * `scanOne` already gives detection.
 */
export function createInProcessRuntime(): PluginRuntime {
  return {
    async load(dir: string, options: LoadOptions = {}): Promise<LoadedPlugin | BrokenPlugin> {
      let manifest: SubshellManifest;
      try {
        const raw = await readFile(join(dir, "package.json"), "utf8");
        const parsed = parseManifest(JSON.parse(raw) as unknown);
        if ("error" in parsed) return { manifest: null, error: parsed.error };
        manifest = parsed;
      } catch (err) {
        return { manifest: null, error: `cannot read ${join(dir, "package.json")}: ${describe(err)}` };
      }

      const entry = options.entryOverrideForTests ?? manifest.entry;
      const entryPath = resolve(dir, entry);
      // Belt to the manifest parser's braces. It refuses a literal `..`, but
      // the value that actually gets imported is this resolved one, so this is
      // the check that has to be true.
      const inside = relative(resolve(dir), entryPath);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        return { manifest, error: `entry '${entry}' resolves outside the plugin directory` };
      }

      try {
        // Read BEFORE the import: afterwards the module is cached either way,
        // and the comparison is the only evidence left that it is the wrong
        // one.
        const seen = await fingerprint(entryPath);
        // `pathToFileURL`, not the bare path: an ESM specifier is a URL, so
        // `#` in a directory name truncates at the fragment, `?` starts a
        // query and `%2F` decodes to a separator. A data dir with any of them
        // otherwise fails as "Cannot find module /home/me/proj", naming
        // neither the plugin nor the cause. Nothing is appended to it: a query
        // string does NOT bust this cache (see IMPORTED).
        const mod: unknown = await import(pathToFileURL(entryPath).href);
        const before = IMPORTED.get(entryPath);
        if (before === undefined) IMPORTED.set(entryPath, seen);
        const stale = before !== undefined && before !== seen;
        const factory = (mod as { default?: unknown }).default;
        if (typeof factory !== "function") {
          return { manifest, error: "the plugin module has no default export, so there is no factory to call" };
        }
        const plugin = (factory as (host: unknown) => SubshellPlugin)(createPluginHost({ pluginId: manifest.id }));
        // Every REQUIRED member, not a sample of them. The adapter calls
        // `validateProfile` unconditionally, so a plugin missing it used to
        // load as healthy and then throw from inside a closure the loader's
        // try/catch no longer covers, surfacing as a 500 rather than as
        // "this plugin is broken".
        const required = ["buildCommand", "validateProfile", "capabilities"] as const;
        const absent = required.filter((m) => typeof plugin?.[m] !== "function");
        if (absent.length > 0) {
          return { manifest, error: `the factory returned an object missing: ${absent.join(", ")}` };
        }
        // A declaration that disagrees with the members present is refused
        // here rather than surfacing later as a feature that silently does
        // nothing: a claimed `resume` with no `resume` object produces a
        // restart that begins a fresh conversation while looking continued.
        const mismatches = capabilityMismatches(plugin);
        if (mismatches.length > 0) {
          return { manifest, error: `capabilities do not match the implementation: ${mismatches.join("; ")}` };
        }
        return stale ? { manifest, plugin, stale: true } : { manifest, plugin };
      } catch (err) {
        return { manifest, error: describe(err) };
      }
    },
  };
}
