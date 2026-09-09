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
 */
export async function listInstalled(dataDir: string): Promise<InstalledPlugin[]> {
  const root = pluginsDir(dataDir);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
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
 * (`readBuiltIn`). Idempotent, and atomic by temp-directory + `rename()`, the
 * same discipline `publishArtifacts` and `allowed-dirs` use, so a killed
 * install never leaves a half-written directory the loader would then report
 * as broken.
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
  try {
    await writeFiles(staging, source);
    const target = join(root, id);
    // rm before rename: rename onto a non-empty directory fails, and an
    // upgrade in place is the common case.
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await enforceMode(target, 0o700);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
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
    const sourceVersion = String(
      (JSON.parse(source.files["package.json"] ?? "{}") as { version?: unknown }).version ?? "",
    );
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
