import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { builtInIds } from "@internal/pane-runtime";
import { enforceMode } from "./fs-mode.js";
import { logger } from "./log.js";
import { installEmbedded, pluginsDir } from "./plugins-dir.js";

/**
 * Giving a node its built-ins, exactly once.
 *
 * `<dataDir>/plugins/` is the node's declaration and empty means "offers
 * nothing", so a node that has never had one would upgrade into offering no
 * harnesses at all. This is the upgrade path, and it is why the enable rows
 * that used to live on the control plane are not migrated: an enabled row said
 * "this server permits the harness here", while this says "this node has the
 * plugin", and only the node can say the second thing.
 *
 * **The check is a MARKER FILE, not the directory.** Directory existence looked
 * equivalent and was not: `installEmbedded` creates the directory before it
 * writes anything, so a kill during the very first seed left a directory that
 * seeding then skipped forever, and the node offered nothing for the rest of
 * its life with nothing anywhere saying why. The marker is written only after
 * the pass completes, so an interrupted first seed is retried and a completed
 * one never is.
 *
 * It must not be emptiness either. An empty directory is a user who
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
 * Installs the built-ins on a node that has never completed a seed.
 * @param dataDir - the agent's data dir
 * @param ids - which built-ins to seed (defaults to every one this build carries)
 * @returns the ids actually installed; empty when the directory already existed
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
      logger.withError(err).warn(`could not seed built-in plugin '${id}'; continuing with the rest`);
    }
  }
  // Last, and only on the way out. Written before the loop it would record a
  // seed that never happened; written on a throw it would record a partial
  // one. Its name cannot be a plugin id (`listInstalled` skips non-ids, and a
  // file is not a directory either), so it never shows up as a plugin.
  await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (seeded.length > 0) {
    logger.info(`seeded ${seeded.length} built-in plugin(s) into ${root}: ${seeded.join(", ")}`);
  }
  return seeded;
}
