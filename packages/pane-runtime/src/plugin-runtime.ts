import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseManifest, type SubshellManifest, type SubshellPlugin } from "@subshell-ai/plugin-api";
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

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        const mod: unknown = await import(entryPath);
        const factory = (mod as { default?: unknown }).default;
        if (typeof factory !== "function") {
          return { manifest, error: "the plugin module has no default export, so there is no factory to call" };
        }
        const plugin = (factory as (host: unknown) => SubshellPlugin)(createPluginHost({ pluginId: manifest.id }));
        if (typeof plugin?.buildCommand !== "function" || typeof plugin?.capabilities !== "function") {
          return {
            manifest,
            error: "the factory did not return a plugin (buildCommand and capabilities are required)",
          };
        }
        return { manifest, plugin };
      } catch (err) {
        return { manifest, error: describe(err) };
      }
    },
  };
}
