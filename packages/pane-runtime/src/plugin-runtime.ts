import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  capabilityMismatches,
  type NetworkPlugin,
  PLUGIN_API_VERSION,
  type PluginType,
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

/**
 * The members a plugin of each type must implement, checked BY NAME at load.
 *
 * A contract gate rather than a crash guard, and the reason it is by name is
 * version skew: a v1 plugin's member was `validateProfile`, so it comes back
 * as "missing validatePreset" and a rebuild is the named fix, instead of the
 * plugin loading and failing at the first launch. Do not trim either list to
 * what today's call sites happen to invoke.
 *
 * The split by type is what admits a second SHAPE behind one store: a network
 * plugin has no argv to build and no preset to validate, and requiring it to
 * ship stubs for both would make "implements the contract" mean nothing.
 */
const REQUIRED_MEMBERS: Record<PluginType, readonly string[]> = {
  "agent-harness": ["buildCommand", "validatePreset", "capabilities"],
  terminal: ["buildCommand", "validatePreset", "capabilities"],
  network: ["status", "join", "leave", "capabilities"],
};

/** A plugin that loaded and is ready to use. */
export interface LoadedPlugin {
  manifest: SubshellManifest;
  /**
   * The object the factory returned.
   *
   * Which shape it is follows from `manifest.type`, and the loader has already
   * proved it: a `network` manifest here carries a {@link NetworkPlugin}, any
   * other carries a {@link SubshellPlugin}. Callers narrow on the type rather
   * than probing for members, because the probe was done once, here, where a
   * failure could still be reported as a broken plugin.
   */
  plugin: SubshellPlugin | NetworkPlugin;
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
  /**
   * The entry file changed since this process first imported it, so `error` is
   * the OLD copy's failure and may already be fixed on disk.
   *
   * This is the case an upgrade usually exists to fix, which is why it has to
   * reach a screen: a plugin that threw at import keeps throwing the cached
   * error forever, so without this the page would show the old failure with no
   * hint that a restart clears it.
   */
  stale?: true;
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
  /**
   * The server's data directory, which is what gives the loaded plugin a
   * secret store.
   *
   * Absent on the node agent, which loads no network plugins and must not be
   * handed a path to invent one under. A plugin built with no store gets one
   * that refuses writes by name rather than one that writes somewhere.
   */
  dataDir?: string;
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
 * Keyed by resolved entry path, valued by a hash of the entry's CONTENT.
 *
 * Content rather than mtime, which was the first attempt: `installEmbedded`
 * rewrites every file unconditionally, so reinstalling the same version moved
 * the mtime and reported an upgrade of byte-identical code. Asking whether the
 * bytes differ is the question this is actually for, and the read costs one
 * file per load.
 *
 * It sees the ENTRY only. A plugin that changed a sibling module and not its
 * entry reads as unchanged, which is the same blind spot mtime had; the entry
 * is what the module cache is keyed by, so it is the honest unit here.
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

/**
 * A refusal, carrying whether the module behind it is known to be out of date.
 *
 * Every refusal below the import is a verdict on the CACHED module rather than
 * on the copy on disk, so each one needs this. Returning the verdict without
 * it is what made an upgrade that fixes a broken plugin invisible.
 */
function broken(manifest: SubshellManifest, error: string, stale: boolean): BrokenPlugin {
  return stale ? { manifest, error, stale: true } : { manifest, error };
}

/** What a file contains right now, for comparison against a past import. */
async function fingerprint(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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

      // Declared out here so the catch can report it. A load that THREW is
      // the most important stale case there is, and it leaves the try through
      // the catch.
      let stale = false;
      try {
        // Recorded BEFORE the import, not after, and this ordering is the
        // whole mechanism. A module whose body throws is still cached, by its
        // error, per the ESM spec: every later import of that path rethrows
        // without re-reading the file. Recording afterwards means a throwing
        // plugin records nothing, so the upgrade that FIXES it is never
        // detected and the page shows the old failure forever.
        const seen = await fingerprint(entryPath);
        const before = IMPORTED.get(entryPath);
        if (before === undefined) IMPORTED.set(entryPath, seen);
        stale = before !== undefined && before !== seen;
        // `pathToFileURL`, not the bare path: an ESM specifier is a URL, so
        // `#` in a directory name truncates at the fragment, `?` starts a
        // query and `%2F` decodes to a separator. A data dir with any of them
        // otherwise fails as "Cannot find module /home/me/proj", naming
        // neither the plugin nor the cause. Nothing is appended to it: a query
        // string does NOT bust this cache (see IMPORTED).
        const mod: unknown = await import(pathToFileURL(entryPath).href);
        const factory = (mod as { default?: unknown }).default;
        if (typeof factory !== "function") {
          return broken(manifest, "the plugin module has no default export, so there is no factory to call", stale);
        }
        const plugin = (factory as (host: unknown) => SubshellPlugin | NetworkPlugin)(
          createPluginHost({ pluginId: manifest.id, ...(options.dataDir ? { dataDir: options.dataDir } : {}) }),
        );
        // Every REQUIRED member, not a sample of them. Nothing calls
        // `validatePreset` today: the adapter passes it through
        // (`plugin-adapter.ts`), but no route or service in the control
        // plane invokes it — `presets.route.ts` validates env keys itself.
        // The member is still required by the published contract, and
        // checking it BY NAME at load is what makes the refusal the
        // plugin-api README sells true: a v1 plugin (whose member was
        // `validateProfile`) comes back as missing `validatePreset`, never
        // as silently working. Contract gate, not crash guard — do not trim
        // this list to current call sites.
        const required = REQUIRED_MEMBERS[manifest.type];
        const absent = required.filter(
          (m) => typeof (plugin as unknown as Record<string, unknown>)?.[m] !== "function",
        );
        if (absent.length > 0) {
          // Name BOTH numbers when the declaration is BELOW the host's, for
          // `parseManifest`'s reason pointing the other way: there, the
          // reader must choose between upgrading the plugin and upgrading
          // the agent. Here the missing member is a SYMPTOM of the skew —
          // `validatePreset` absent because the plugin was built against
          // plugin-api 1, where it was `validateProfile` — and the member
          // name alone does not say that rebuilding is the fix.
          const skew =
            manifest.apiVersion < PLUGIN_API_VERSION
              ? `; it declares plugin-api ${manifest.apiVersion} and this host implements ${PLUGIN_API_VERSION} — rebuild it against ${PLUGIN_API_VERSION}`
              : "";
          return broken(manifest, `the factory returned an object missing: ${absent.join(", ")}${skew}`, stale);
        }
        // A declaration that disagrees with the members present is refused
        // here rather than surfacing later as a feature that silently does
        // nothing: a claimed `resume` with no `resume` object produces a
        // restart that begins a fresh conversation while looking continued.
        const mismatches = capabilityMismatches(plugin, manifest.type);
        if (mismatches.length > 0) {
          return broken(manifest, `capabilities do not match the implementation: ${mismatches.join("; ")}`, stale);
        }
        // A PUBLIC exposure without a guard is refused at LOAD, where every
        // other contract violation is already named, rather than at the moment
        // an admin presses publish. The host refuses to publish or to arm such
        // a plugin anyway; saying so at install time is what turns "this fails
        // when you use it" into "this cannot be installed", and it costs one
        // check where the manifest and the object are both already in hand.
        if (
          manifest.network?.exposure === "public-with-gate" &&
          typeof (plugin as { requestGuard?: unknown }).requestGuard !== "function"
        ) {
          return broken(
            manifest,
            'it declares `exposure: "public-with-gate"` — publishing reaches the open internet — but implements no `requestGuard`, so nothing could be put in front of it',
            stale,
          );
        }
        // The two publish-state witnesses are mutually exclusive BY WHAT
        // THEY CLAIM: `publishImplicit` says the publish leaves nothing the
        // daemon can be asked about (the host's record is the witness), while
        // a `supervisedProcess` means the host's own child is the daemon and
        // its running is the witness. A plugin declaring both would be
        // reported published by one merge while the other saw a parked child
        // — a contradiction about a state the UI renders as one word. Refused
        // at load, like every other disagreement between declaration and
        // implementation.
        if (
          manifest.network?.publishImplicit === true &&
          typeof (plugin as { supervisedProcess?: unknown }).supervisedProcess === "function"
        ) {
          return broken(
            manifest,
            "it declares `publishImplicit: true` (the host's record is the published state) AND implements `supervisedProcess` (the child's running is) — pick one witness",
            stale,
          );
        }
        return stale ? { manifest, plugin, stale: true } : { manifest, plugin };
      } catch (err) {
        return broken(manifest, describe(err), stale);
      }
    },
  };
}
