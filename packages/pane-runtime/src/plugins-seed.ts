import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { builtInIds } from "./builtin-source.js";
import { enforceMode } from "./fs-mode.js";
import {
  installEmbedded,
  pluginLog,
  pluginsDir,
  recoverInterruptedInstalls,
  refreshStaleBuiltIns,
} from "./plugins-dir.js";

/**
 * Giving the instance's plugin store its built-ins, exactly once.
 *
 * The store at `<dataDir>/plugins/` is the instance's declaration of what it
 * offers (spec 2026-09-10 §6: one store, on the control plane; nodes hold
 * nothing), and empty means "offers nothing" — so an instance store that has
 * never been seeded would boot offering no harnesses at all. This is that
 * first-boot path, and it is why the enable rows that used to live per-node
 * are not migrated: an enabled row said "this server permits the harness on
 * that node", while a seeded directory says "this instance has the plugin",
 * and only the store can say the second thing.
 *
 * **The check is a MARKER FILE, not the directory.** Directory existence looked
 * equivalent and was not: `installEmbedded` creates the directory before it
 * writes anything, so a kill during the very first seed left a directory that
 * seeding then skipped forever, and the store offered nothing for the rest of
 * the instance's life with nothing anywhere saying why. The marker is written
 * only after the pass completes, so an interrupted first seed is retried and a
 * completed one never is.
 *
 * It must not be emptiness either. An empty directory is an operator who
 * uninstalled everything, and re-seeding would undo that on every restart,
 * which is why the empty case still creates the directory and the marker:
 * "I want nothing here" has to be reachable.
 *
 * One-way by construction. It never removes, never upgrades, and never runs
 * again once the directory exists; `refreshStaleBuiltIns` is the separate
 * concern of keeping an installed built-in current.
 */

/** Written once the first seed COMPLETES; its presence is what stops a second. */
const SEEDED_MARKER = ".seeded";

/**
 * Installs the built-ins into an instance store that has never completed a seed.
 * @param dataDir - the data dir whose plugins directory is the store
 * @param ids - which built-ins to seed (defaults to every one this build carries)
 * @returns the ids actually installed; empty when the marker already exists
 */
export async function seedBuiltIns(dataDir: string, ids?: string[]): Promise<string[]> {
  const root = pluginsDir(dataDir);
  const marker = join(root, SEEDED_MARKER);
  if (existsSync(marker)) return [];

  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);

  const seeded: string[] = [];
  for (const id of ids ?? (await builtInIds())) {
    try {
      await installEmbedded(dataDir, id);
      seeded.push(id);
    } catch (err) {
      // One built-in that cannot be installed must not cost the node every
      // other harness it could have offered.
      pluginLog().warn(`could not seed built-in plugin "${id}", continuing with the rest`, err);
    }
  }
  // Last, and only on the way out. Written before the loop it would record a
  // seed that never happened; written on a throw it would record a partial
  // one. Its name cannot be a plugin id (`listInstalled` skips non-ids, and a
  // file is not a directory either), so it never shows up as a plugin.
  await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (seeded.length > 0) {
    pluginLog().info(`seeded ${seeded.length} built-in plugin(s) into ${root}: ${seeded.join(", ")}`);
  }
  return seeded;
}

/**
 * Bring a data dir's plugins to a usable state: recover, seed, refresh.
 *
 * ONE definition of the boot sequence. The agent daemon stopped calling it
 * when the inversion took plugins off the nodes (spec 2026-09-10 §6); its
 * only production caller today is the control plane's boot
 * (`prepareLocalPlugins`), which is exactly what "one store" means. It stays
 * here because the store mechanics are pane-runtime's — agent and plane ran
 * the same three steps in two different orders before, each with a comment
 * claiming the order mattered, which is the drift this shape removes.
 *
 * The order is recover, then seed, then refresh:
 *
 * 1. **Recover first.** An install interrupted mid-swap left the plugin only
 *    under `.old-…`; putting it back before anything else means seeding sees a
 *    populated directory and the refresh can bring the restored copy current.
 *    Seeding first would find the directory already there, skip, and leave the
 *    recovery to run against a set nothing will then refresh.
 * 2. **Seed second**, keyed on the completion marker, so a store that has
 *    never completed a seed gets the built-ins exactly once.
 * 3. **Refresh last**, so a built-in whose on-disk copy predates this build is
 *    brought current whether it was seeded, recovered, or already there.
 *
 * Every step is independently guarded. One failing must not cost the others:
 * a store that cannot refresh should still offer what it has, and a store
 * that cannot seed should still recover.
 * @param dataDir - the data dir whose `plugins/` to prepare
 */
export async function prepareInstalledPlugins(dataDir: string): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["recover interrupted plugin installs", () => recoverInterruptedInstalls(dataDir)],
    ["seed built-in plugins", () => seedBuiltIns(dataDir)],
    ["refresh stale built-in plugins", () => refreshStaleBuiltIns(dataDir)],
  ];
  for (const [what, run] of steps) {
    try {
      await run();
    } catch (err) {
      pluginLog().warn(`could not ${what}`, err);
    }
  }
}
