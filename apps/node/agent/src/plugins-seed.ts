import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
 * **The check is whether the DIRECTORY exists, not whether it has anything in
 * it.** An empty directory is a user who uninstalled everything, and re-seeding
 * would undo that on every restart. That is also why the empty case still
 * CREATES the directory: leaving it absent would make "I want nothing here"
 * unreachable.
 *
 * One-way by construction. It never removes, never upgrades, and never runs
 * again once the directory exists; `refreshStaleBuiltIns` is the separate
 * concern of keeping an installed built-in current.
 */

/**
 * Installs the built-ins on a node that has never had a plugins directory.
 * @param dataDir - the agent's data dir
 * @param ids - which built-ins to seed (defaults to every one this build carries)
 * @returns the ids actually installed; empty when the directory already existed
 */
export async function seedBuiltIns(dataDir: string, ids?: string[]): Promise<string[]> {
  const root = pluginsDir(dataDir);
  if (existsSync(root)) return [];

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
  if (seeded.length > 0) {
    logger.info(`seeded ${seeded.length} built-in plugin(s) into ${root}: ${seeded.join(", ")}`);
  }
  return seeded;
}
