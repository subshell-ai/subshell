import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * **The check is the MARKER'S CONTENTS, not the directory and not the
 * marker's existence.** Directory existence looked equivalent to a completed
 * seed and was not: `installEmbedded` creates the directory before it writes
 * anything, so a kill during the very first seed left a directory that
 * seeding then skipped forever. Existence of the marker fixed that and
 * introduced a second problem: it made seeding a one-time EVENT, so a
 * built-in added in a later release could never reach an instance that had
 * already booted. The marker therefore records WHICH ids were seeded.
 *
 * It must not be emptiness either. An empty directory is an operator who
 * uninstalled everything, and re-seeding would undo that on every restart,
 * which is why an id in the record is never installed a second time even when
 * it is absent from disk: "I want nothing here" has to be reachable.
 *
 * One-way per id. It never removes and never upgrades;
 * `refreshStaleBuiltIns` is the separate concern of keeping an installed
 * built-in current.
 */

/** Records which built-ins this store has ever seeded; its CONTENTS stop a re-seed. */
const SEEDED_MARKER = ".seeded";

/**
 * The built-ins that existed before the marker recorded ids.
 *
 * A legacy marker is a timestamp, which says a seed completed but not of
 * what. It can only have been these five, so that is what it reads as. Frozen
 * deliberately: this is a historical fact about old instances, not the
 * current built-in set, and appending to it would re-seed something an
 * operator uninstalled.
 */
const PRE_RECORD_BUILT_INS = ["claude-code", "codex", "hermes", "opencode", "pi"] as const;

/** What {@link readSeededRecord} found; `null` means the marker must not be trusted. */
interface SeededRecord {
  /** Ids already seeded (absent marker = none, so a virgin store seeds everything) */
  already: Set<string>;
  /** Whether the marker file existed (drives the no-op steady-state pass) */
  existed: boolean;
}

/**
 * Read the seed record, refusing to guess.
 *
 * Three honest shapes and one dead end: no file (virgin, seed everything); a
 * JSON array of ids (the record); a leading-date line (exactly what the
 * pre-record implementation wrote — an ISO timestamp — which can only mean
 * {@link PRE_RECORD_BUILT_INS}). Anything else — empty, truncated, valid JSON
 * of the wrong shape, unparseable garbage — is either a torn write or
 * tampering, and GUESSING it would persist the guess: the union write below
 * turns whatever was read into the durable record. An operator who
 * uninstalled `terminal` and then lost the marker to a corrupt write must not
 * wake to it resurrected and permanently recorded, so a marker this code
 * cannot read stops the pass with a warning. The pre-record code needed no
 * such gate (its marker was a boolean); a CONTENTS-based record does.
 */
async function readSeededRecord(marker: string): Promise<SeededRecord | null> {
  if (!existsSync(marker)) return { already: new Set(), existed: false };
  let raw: string;
  try {
    raw = await readFile(marker, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return { already: new Set(parsed as string[]), existed: true };
    }
    return null;
  } catch {
    // Not JSON. The legacy marker was ONE known thing; match it exactly.
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return { already: new Set(PRE_RECORD_BUILT_INS), existed: true };
    return null;
  }
}

/**
 * Installs the built-ins this store has never seeded.
 *
 * Was keyed on the marker's EXISTENCE, which made the seed a one-time event
 * and meant a built-in added in a later release could never reach an instance
 * that had already booted. The marker now records which ids were seeded, so
 * the set can grow while the property that mattered is unchanged: an id in
 * the record is never installed again, so an uninstall still sticks forever.
 * @param dataDir - the data dir whose plugins directory is the store
 * @param ids - which built-ins to consider (defaults to every one this build carries)
 * @returns the ids actually installed by THIS pass; empty when there is nothing new
 */
export async function seedBuiltIns(dataDir: string, ids?: string[]): Promise<string[]> {
  const root = pluginsDir(dataDir);
  const marker = join(root, SEEDED_MARKER);
  const record = await readSeededRecord(marker);
  if (!record) {
    pluginLog().warn(
      `the seed marker at ${marker} is empty, truncated, or not a shape any version of this code wrote; ` +
        "refusing to seed rather than write a guess over it",
    );
    return [];
  }
  const wanted = ids ?? (await builtInIds());
  const todo = wanted.filter((id) => !record.already.has(id));

  // Steady state (the ordinary boot of every existing instance): the record
  // exists and holds everything wanted. Touch nothing. The pre-record code
  // returned early here too, and for a reason that survives: a store on
  // read-only or root-owned media must keep booting on its existing set,
  // where an unconditional mkdir/chmod/write pair would throw every boot and
  // train the operator to ignore the warning.
  if (record.existed && todo.length === 0) return [];

  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);

  const seeded: string[] = [];
  for (const id of todo) {
    try {
      await installEmbedded(dataDir, id);
      seeded.push(id);
    } catch (err) {
      // One built-in that cannot be installed must not cost the instance every
      // other harness it could have offered. It stays OUT of the record, so
      // the next boot retries it.
      pluginLog().warn(`could not seed built-in plugin "${id}", continuing with the rest`, err);
    }
  }

  // Last, and only on the way out. Written before the loop it would record a
  // seed that never happened; written on a throw it would record a partial
  // one. Its name cannot be a plugin id (`listInstalled` skips non-ids, and a
  // file is not a directory either), so it never shows up as a plugin.
  //
  // Temp + rename, never in place: the marker's CONTENTS are the record now,
  // and a torn write (killed mid-`writeFile`) would leave empty or truncated
  // JSON — which {@link readSeededRecord} now refuses rather than guessing
  // past, so an unbreakable write matters even more than the gate. A leftover
  // `.tmp-<pid>` file costs nothing: `listInstalled` skips files.
  //
  // The union, not `seeded`: everything previously recorded stays recorded,
  // including the five a legacy marker stood for, or an upgrade would offer
  // to re-seed what an operator had removed.
  const tmp = `${marker}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify([...record.already, ...seeded].sort()), { mode: 0o600 });
  await rename(tmp, marker);
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
 * 2. **Seed second**, keyed on the marker's record of which ids were seeded,
 *    so a store gets every built-in it has never been seeded and none twice.
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
