import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type EmbeddedPlugin, readBuiltIn } from "@internal/pane-runtime";
import { parseManifest, type SubshellManifest } from "@subshell-ai/plugin-api";
import { enforceMode } from "./fs-mode.js";
import { logger } from "./log.js";

/**
 * This node's declaration of what it offers.
 *
 * `<dataDir>/plugins/<id>/` holds one directory per installed plugin, and what
 * is in there IS the answer: there is no enable flag, on this side or on the
 * control plane's.
 *
 * **Empty means "offers nothing", which INVERTS `allowed-dirs.ts`.** That file
 * treats an absent list as unrestricted, because an allowlist is a restriction
 * an owner opts into and failing open is the safe direction for it. A plugin
 * set is the opposite kind of statement: it is a positive list of what is
 * installed, and inventing entries for a node that has none would offer
 * harnesses nobody put there. It is also why the seeding step exists rather
 * than being a nicety, since without it an upgraded node would offer nothing.
 *
 * A built-in and a third-party plugin are IDENTICAL on disk, which is the
 * point: one loader, one uninstall, one listing. Installing a built-in just
 * means the bytes came from this build rather than from a registry.
 */

/** Directory name inside the agent data dir. */
const DIR = "plugins";

/** Ids become directory names, so they are path segments and nothing else. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One plugin installed on this node. */
export interface InstalledPlugin {
  /** Plugin id, which is also its directory name */
  id: string;
  /** Its parsed `subshell` block */
  manifest: SubshellManifest;
  /** The package version, for comparing against what this build carries */
  version: string;
  /** Why it cannot be used, when it cannot. Absent on a healthy plugin. */
  broken?: string;
}

/** Absolute path of the plugins directory for a data dir. */
export function pluginsDir(dataDir: string): string {
  return join(dataDir, DIR);
}

/** Throws unless `id` is a safe single path segment. */
function assertSafeId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(`invalid plugin id '${id}': ids are lowercase letters, digits and hyphens`);
  }
}

/**
 * Every installed plugin, id-sorted.
 *
 * Total: an absent directory answers `[]` and does NOT create anything, a
 * stray file is skipped, and a directory whose manifest will not parse is
 * reported `broken` rather than omitted. Omitting it would make a
 * misconfigured plugin indistinguishable from one nobody installed.
 *
 * A directory whose name is not a valid id is skipped, not reported. That is
 * what keeps this function's own working directories out of its answer:
 * `.tmp-…` and `.old-…` are named so they cannot be ids, and an install in
 * flight would otherwise show up as a broken plugin with no `package.json`
 * that no uninstall could remove (uninstall refuses the same names).
 */
export async function listInstalled(dataDir: string): Promise<InstalledPlugin[]> {
  const root = pluginsDir(dataDir);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && ID_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: InstalledPlugin[] = [];
  for (const id of entries.sort()) {
    const pkgPath = join(root, id, "package.json");
    let raw: string;
    try {
      raw = await readFile(pkgPath, "utf8");
    } catch {
      out.push({ id, manifest: placeholderManifest(id), version: "", broken: `no package.json at ${pkgPath}` });
      continue;
    }
    let parsed: ReturnType<typeof parseManifest>;
    try {
      parsed = parseManifest(JSON.parse(raw) as unknown);
    } catch (err) {
      out.push({
        id,
        manifest: placeholderManifest(id),
        version: "",
        broken: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if ("error" in parsed) {
      out.push({ id, manifest: placeholderManifest(id), version: "", broken: parsed.error });
      continue;
    }
    const version = String((JSON.parse(raw) as { version?: unknown }).version ?? "");
    out.push({ id, manifest: parsed, version });
  }
  return out;
}

/**
 * A stand-in manifest for a broken plugin, so callers can render its id.
 *
 * A broken plugin still occupies a row on the node's page; giving it a shape
 * is what lets that row carry a name and an error instead of being dropped.
 */
function placeholderManifest(id: string): SubshellManifest {
  return { apiVersion: 1, id, type: "agent-harness", name: id, description: "", entry: "" };
}

/** Writes one plugin's files into `target`, creating directories as needed. */
async function writeFiles(target: string, plugin: EmbeddedPlugin): Promise<void> {
  for (const [rel, content] of Object.entries(plugin.files)) {
    const path = join(target, rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
}

/**
 * Installs a built-in from the bytes this build carries.
 *
 * No network: the bytes come from the checkout or from the binary
 * (`readBuiltIn`). Idempotent on disk, and staged in a temp directory so a
 * killed install never leaves a half-written plugin the loader would then
 * report as broken.
 *
 * **The swap is a rename ASIDE, then a rename INTO place.** Removing the old
 * directory first (which `rename` onto a non-empty directory requires) left a
 * window in which the plugin existed nowhere: a kill during a recursive
 * delete uninstalls what the operator was upgrading. Renaming it out of the
 * way instead narrows that window to one atomic syscall, and the copy it
 * displaced survives under `.old-…` — which is what
 * {@link recoverInterruptedInstalls} puts back at the next boot, so even a
 * kill inside that window costs nothing.
 *
 * **What it does NOT do is change the code a RUNNING agent executes.** The
 * module cache cannot be evicted (see `IMPORTED` in `@internal/pane-runtime`),
 * so an upgrade in place takes effect on the next restart, and the report
 * carries `restartRequired` until then.
 * @param dataDir - the agent's data dir
 * @param id - built-in plugin id
 */
export async function installEmbedded(dataDir: string, id: string): Promise<InstalledPlugin> {
  assertSafeId(id);
  const source = await readBuiltIn(id);
  if (!source) throw new Error(`no built-in plugin '${id}' in this build`);

  const root = pluginsDir(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);

  const staging = await mkdtemp(join(root, `.tmp-${id}-`));
  const retired = join(root, `.old-${id}-${randomUUID()}`);
  let asideHolds = false;
  try {
    await writeFiles(staging, source);
    const target = join(root, id);
    if (existsSync(target)) {
      await rename(target, retired);
      asideHolds = true;
    }
    await rename(staging, target);
    await enforceMode(target, 0o700);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    // Put it back. A failed upgrade must leave the previous copy installed,
    // which is the same direction `refreshStaleBuiltIns` chose.
    if (asideHolds && !existsSync(join(root, id))) await rename(retired, join(root, id)).catch(() => {});
    throw err;
  } finally {
    await rm(retired, { recursive: true, force: true }).catch(() => {});
  }

  const found = (await listInstalled(dataDir)).find((p) => p.id === id);
  if (!found) throw new Error(`installed '${id}' but it did not read back; the data dir may not be writable`);
  return found;
}

/**
 * Removes an installed plugin.
 * @returns true when something was removed, false when it was not there
 */
export async function uninstallPlugin(dataDir: string, id: string): Promise<boolean> {
  assertSafeId(id);
  const target = join(pluginsDir(dataDir), id);
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

/** What a boot-time recovery pass did. */
export interface RecoveredInstalls {
  /** Ids whose previous copy was put back, because the swap never completed */
  recovered: string[];
  /** How many leftover working directories were removed */
  removed: number;
}

/**
 * Finishes or undoes whatever an interrupted install left behind.
 *
 * `installEmbedded` swaps by renaming the old copy to `.old-…` and the new one
 * into place. A process killed between those two renames leaves the plugin
 * absent with its only copy under `.old-…` — so this pass RESTORES it when the
 * id it names is missing, and removes it when the id is present (the swap
 * completed; that copy is superseded). A `.tmp-…` is always garbage: it is a
 * staging directory whose contents were never promoted.
 *
 * The id comes from the directory's OWN manifest rather than from its name.
 * Plugin ids contain hyphens, so parsing one back out of `.old-<id>-<uuid>` is
 * guesswork; a copy whose manifest will not parse is removed, since there is
 * nothing it could be restored as.
 *
 * **Safe only where nothing is installing**, which is why this is a BOOT step
 * and not part of `installEmbedded`: running it mid-flight would delete a live
 * install's staging directory, or restore a copy over one being written.
 */
export async function recoverInterruptedInstalls(dataDir: string): Promise<RecoveredInstalls> {
  const root = pluginsDir(dataDir);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && (e.name.startsWith(".tmp-") || e.name.startsWith(".old-")))
      .map((e) => e.name);
  } catch {
    return { recovered: [], removed: 0 };
  }

  const recovered: string[] = [];
  let removed = 0;
  for (const name of entries.sort()) {
    const path = join(root, name);
    try {
      const id = name.startsWith(".old-") ? await idOf(path) : null;
      if (id && !existsSync(join(root, id))) {
        await rename(path, join(root, id));
        recovered.push(id);
        logger.info(`restored plugin '${id}' from an install that was interrupted mid-swap`);
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      logger.withError(err).warn(`could not clean up the leftover plugin directory '${name}'`);
    }
  }
  return { recovered: recovered.sort(), removed };
}

/** The plugin id a directory declares, or null when it declares nothing usable. */
async function idOf(dir: string): Promise<string | null> {
  try {
    const parsed = parseManifest(JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown);
    return "error" in parsed ? null : parsed.id;
  } catch {
    return null;
  }
}

/**
 * Re-installs any built-in whose on-disk copy differs from this build's.
 *
 * The binary and its built-ins ship together, so a stale on-disk copy of a
 * built-in is never something a user chose: it means the agent was upgraded
 * underneath it. A plugin this build carries no copy of is left strictly
 * alone, because overwriting a third-party plugin from nowhere would be data
 * loss rather than a refresh.
 * @returns the ids that were refreshed, id-sorted
 */
export async function refreshStaleBuiltIns(dataDir: string): Promise<string[]> {
  const refreshed: string[] = [];
  for (const installed of await listInstalled(dataDir)) {
    const source = await readBuiltIn(installed.id);
    if (!source) continue;
    // Inside the loop's own guard, not outside it. This parse is of THIS
    // BUILD's bytes, so a throw here is a build defect rather than a user's
    // doing, and letting it escape would abandon every plugin after this one
    // in the id order: one malformed built-in, and an upgraded agent silently
    // keeps stale copies of all the rest.
    let sourceVersion: string;
    try {
      sourceVersion = String((JSON.parse(source.files["package.json"] ?? "{}") as { version?: unknown }).version ?? "");
    } catch (err) {
      logger.withError(err).warn(`built-in plugin '${installed.id}' has an unreadable package.json in this build`);
      continue;
    }
    if (sourceVersion === installed.version && !installed.broken) continue;
    try {
      await installEmbedded(dataDir, installed.id);
      refreshed.push(installed.id);
    } catch (err) {
      // A refresh that fails leaves the previous copy in place, which is the
      // safe direction: the node keeps offering what it last had.
      logger.withError(err).warn(`could not refresh built-in plugin '${installed.id}'; keeping the installed copy`);
    }
  }
  return refreshed.sort();
}
