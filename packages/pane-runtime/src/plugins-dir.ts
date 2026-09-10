import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { semverLt } from "@internal/subshell-protocol";
import { parseManifest, type SubshellManifest } from "@subshell-ai/plugin-api";
import { builtInIds, readBuiltIn } from "./builtin-source.js";
import { enforceMode } from "./fs-mode.js";
import { DEFAULT_REGISTRY_URL, fetchVerifiedTarball, parsePackageSpec, resolvePackageVersion } from "./npm-registry.js";
import { createInProcessRuntime } from "./plugin-runtime.js";
import { extractTgz } from "./tar-vendor.js";

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

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Where this module reports what it did.
 *
 * A SINK rather than a direct `console` call, because both hosts route their
 * own output: the agent through LogLayer with an `[subshell <ISO>]` prefix and
 * a flattened error, the server through LogLayer too. Writing to `console`
 * from here put an unmanaged writer inside both, unstructured and outside the
 * `withError` chain the surrounding boot code logs with.
 *
 * The default is `console` so a bare consumer of this package still says
 * something rather than swallowing failures.
 */
export interface PluginLog {
  info(message: string): void;
  warn(message: string, err?: unknown): void;
}

const CONSOLE_LOG: PluginLog = {
  info: (m) => console.info(`subshell: ${m}`),
  warn: (m, err) => console.warn(err === undefined ? `subshell: ${m}` : `subshell: ${m}: ${describe(err)}`),
};

let sink: PluginLog = CONSOLE_LOG;

/**
 * Routes this module's output through the host's logger.
 *
 * Called once at boot by each host. Module-level rather than a parameter on
 * every function because the alternative is threading a logger through five
 * signatures and their callers for one setting that never varies per call.
 */
export function setPluginLog(log: PluginLog): void {
  sink = log;
}

/** @internal Restores the default sink; tests only. */
export function resetPluginLogForTests(): void {
  sink = CONSOLE_LOG;
}

/** The sink this module writes to. */
export function pluginLog(): PluginLog {
  return sink;
}

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
async function writeFiles(target: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(target, rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
}

/** The sidecar file inside an installed plugin directory that names its registry origin. */
const RECORD_FILE = "install.json";

/** What an installed-from-the-registry plugin records about where it came from. */
export interface InstallRecord {
  /** The npm package name the bytes were installed from */
  name: string;
  /** The exact version installed */
  version: string;
  /** The SRI `sha512-…` digest the tarball was verified against */
  integrity: string;
  /** ISO 8601 timestamp of the install */
  installedAt: string;
}

/**
 * Where an installed plugin came from, or null.
 *
 * Null means either "embedded" (the bytes came from this build, so there is
 * no registry name to record) or "absent"; the sidecar rides INSIDE the plugin
 * directory, so removing the plugin removes its record with it, and a
 * directory without one is exactly what `installEmbedded` produces.
 */
export async function readInstallRecord(dataDir: string, id: string): Promise<InstallRecord | null> {
  try {
    assertSafeId(id);
    return await readRecordIn(join(pluginsDir(dataDir), id));
  } catch {
    return null;
  }
}

/** Reads the sidecar from a plugin directory, null when it has none (or it will not parse). */
async function readRecordIn(dir: string): Promise<InstallRecord | null> {
  try {
    return JSON.parse(await readFile(join(dir, RECORD_FILE), "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}

/** The existing state of an install target: its parsed manifest plus any record. */
interface TargetState {
  manifest: SubshellManifest;
  /** The `name` field of the target's package.json, null when it has none */
  pkgName: string | null;
  record: InstallRecord | null;
}

/**
 * What a directory currently declares as a plugin, or null when it declares
 * nothing usable.
 *
 * A target whose manifest will not parse answers null, the same call
 * `listInstalled` makes when it reports a directory broken: an install may
 * overwrite a broken directory, because there is no working copy there to
 * protect.
 *
 * `pkgName` is captured alongside the record because the record only exists
 * for registry installs. An EMBEDDED copy has no sidecar, and its
 * package.json name is the only claim on its id such a copy carries.
 */
async function readTargetState(dir: string): Promise<TargetState | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
    const parsed = parseManifest(pkg);
    if ("error" in parsed) return null;
    const nameField = (pkg as { name?: unknown }).name;
    return {
      manifest: parsed,
      pkgName: typeof nameField === "string" ? nameField : null,
      record: await readRecordIn(dir),
    };
  } catch {
    return null;
  }
}

/**
 * Installs a built-in from the bytes this build carries.
 *
 * No network: the bytes come from the checkout or from the binary
 * (`readBuiltIn`). Idempotent on disk; the staging and swap live in
 * {@link installStaged}, which the registry path shares.
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
  return await installStaged(dataDir, id, source.files);
}

/**
 * Writes `files` into a fresh staging dir, modes it, and swaps it into
 * `<pluginsDir>/<id>` by the rename-aside dance. Both install paths (embedded
 * and registry) share this, so the "a killed install never leaves a
 * half-written plugin" property lives in exactly one place.
 *
 * **The swap is a rename ASIDE, then a rename INTO place.** Removing the old
 * directory first (which `rename` onto a non-empty directory requires) left a
 * window in which the plugin existed nowhere: a kill during a recursive
 * delete uninstalls what the operator was upgrading. Renaming it out of the
 * way instead narrows that window to one atomic syscall, and the copy it
 * displaced survives under `.old-…` — which is what
 * {@link recoverInterruptedInstalls} puts back at the next boot, so even a
 * kill inside that window costs nothing.
 * @param assertTarget - runs against the EXISTING target (or null when there
 *   is none, or its manifest will not parse) BEFORE the first rename, so a
 *   refusal here moves nothing on disk
 */
async function installStaged(
  dataDir: string,
  id: string,
  files: Record<string, string | Uint8Array>,
  assertTarget?: (existing: TargetState | null) => void,
): Promise<InstalledPlugin> {
  const root = pluginsDir(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);

  const staging = await mkdtemp(join(root, `.tmp-${id}-`));
  const retired = join(root, `.old-${id}-${randomUUID()}`);
  let asideHolds = false;
  try {
    await writeFiles(staging, files);
    // Permissions are set on the STAGING copy, before it is anything. Doing it
    // after the rename put a step that can throw between "installed" and
    // "reported installed": the caller then saw a failure for a plugin that
    // is on disk and running, the mirror on the control plane never learned
    // about it, and every launch of it was refused until the next inventory.
    await enforceMode(staging, 0o700);
    const target = join(root, id);
    assertTarget?.(existsSync(target) ? await readTargetState(target) : null);
    if (existsSync(target)) {
      await rename(target, retired);
      asideHolds = true;
    }
    await rename(staging, target);
  } catch (err) {
    // RESTORE FIRST. This used to sit behind an unguarded `rm` of the staging
    // directory, and `force: true` only swallows ENOENT: an EACCES or EIO
    // there skipped the restore, and the `finally` then deleted the only
    // remaining copy. That is the "uninstalled what the operator was
    // upgrading" outcome this whole shape exists to prevent, reached by an
    // exception instead of a kill.
    if (asideHolds && !existsSync(join(root, id))) await rename(retired, join(root, id)).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
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
        sink.info(`restored plugin "${id}" from an install that was interrupted mid-swap`);
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      sink.warn(`could not clean up the leftover plugin directory "${name}"`, err);
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
 * Installs one plugin from an npm registry: resolve, verify, unpack, check,
 * swap. INTERNAL to this module: `installPlugin` is the one door, and the
 * embedded-first decision belongs to it.
 *
 * Ordering is the safety property: integrity is verified over the raw bytes
 * BEFORE anything is written (in `fetchVerifiedTarball`), the id checks run
 * before the swap, and the load-check runs against a staging copy before the
 * swap too, so every refusal here leaves the previous copy untouched.
 * @param expectId - the id the caller asked for, when they named one; the manifest's own id must agree
 */
async function installFromRegistry(
  dataDir: string,
  spec: string,
  expectId: string | undefined,
  registryUrl: string,
): Promise<InstalledPlugin> {
  const { name, range } = parsePackageSpec(spec);
  const resolved = await resolvePackageVersion(name, range, registryUrl);
  const tgz = await fetchVerifiedTarball(resolved, registryUrl);
  const files: Record<string, string | Uint8Array> = {};
  // `extractTgz` already stripped npm's `package/` wrapper and refused
  // anything else; the entry path maps straight into the plugin directory.
  for (const e of extractTgz(tgz)) files[e.path] = e.content;

  const pkgRaw = files["package.json"];
  if (pkgRaw === undefined) throw new Error(`'${spec}' has no package.json at its root`);
  const pkg = JSON.parse(typeof pkgRaw === "string" ? pkgRaw : new TextDecoder().decode(pkgRaw)) as unknown;
  const parsed = parseManifest(pkg);
  if ("error" in parsed) throw new Error(`'${spec}': ${parsed.error}`);
  const id = parsed.id;
  assertSafeId(id);
  if (expectId !== undefined && expectId !== id) {
    throw new Error(`'${spec}' is plugin '${id}', not '${expectId}'; refusing to install it under the wrong id`);
  }

  // The record rides INSIDE the swap so it can never describe a different
  // copy than the one it names.
  const record: InstallRecord = {
    name,
    version: resolved.version,
    integrity: resolved.integrity,
    installedAt: new Date().toISOString(),
  };
  files[RECORD_FILE] = `${JSON.stringify(record, null, 2)}\n`;

  // Load-check BEFORE anything moves (spec §8.1): the staging dir is a plugin
  // directory as far as the loader is concerned, and a module that throws (or
  // mismatches its declared capabilities) is refused here, so an operator who
  // installs a broken package keeps the copy they had.
  const root = pluginsDir(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await enforceMode(root, 0o700);
  const checkDir = await mkdtemp(join(root, `.tmp-${id}-check-`));
  try {
    await writeFiles(checkDir, files);
    const loaded = await createInProcessRuntime().load(checkDir);
    if ("error" in loaded) throw new Error(`'${spec}' loaded with an error: ${loaded.error}`);
  } finally {
    await rm(checkDir, { recursive: true, force: true }).catch(() => {});
  }

  return await installStaged(dataDir, id, files, (existing) => {
    // Two packages claiming one id would silently replace the first operator's
    // plugin with the second's bytes. The claim is the sidecar when there is
    // one, and the target's OWN package.json name when there is not: an
    // embedded install carries no sidecar, and without that second half a
    // registry package declaring a built-in's id could swap over the built-in
    // and have the swap RECORD the squatter. A same-name target is the
    // §2.5-rule-3 flow (this build's pi replaced by a registry pi), which
    // must pass.
    const claimedBy = existing?.record?.name ?? existing?.pkgName ?? null;
    if (claimedBy && claimedBy !== name) {
      const origin = existing?.record
        ? `installed ${existing.record.version}`
        : "no install record, so it is this build's copy or one dropped in by hand";
      throw new Error(
        `'${claimedBy}' already claims plugin id '${id}' (${origin}); uninstall it before installing '${name}' under that id`,
      );
    }
  });
}

/**
 * The one install door (spec §2.5's four rules, stated once):
 * - spec absent → embedded `id` (the v1 meaning, unchanged);
 * - spec pins no version and names a built-in id → embedded, no network;
 * - spec pins the embedded version → embedded (no byte churn);
 * - otherwise → registry, and a pinned version the registry cannot answer is
 *   an ERROR, never a silent fallback.
 * Both hosts call this; the agent's command handler and CLI are thin.
 */
export async function installPlugin(
  dataDir: string,
  opts: { id?: string; spec?: string; registryUrl?: string },
): Promise<InstalledPlugin> {
  const registryUrl = opts.registryUrl ?? DEFAULT_REGISTRY_URL;
  if (opts.spec === undefined) {
    if (opts.id === undefined) throw new Error("install needs an id or a spec");
    return await installEmbedded(dataDir, opts.id);
  }
  const { name, range } = parsePackageSpec(opts.spec);
  const builtinCandidate = opts.id ?? name;
  if ((await builtInIds()).includes(builtinCandidate)) {
    if (range === undefined) return await installEmbedded(dataDir, builtinCandidate);
    const source = await readBuiltIn(builtinCandidate);
    // No unguarded parse: `builtInIds` lists checkout DIRECTORIES, and a
    // directory whose bytes this build cannot actually install (no dist) is
    // not a source for a version pin to match against. Falling through to the
    // registry there errors honestly; inventing a mismatch would not.
    if (source) {
      const pkgRaw = source.files["package.json"] ?? "{}";
      const embeddedVersion = String((JSON.parse(pkgRaw) as { version?: unknown }).version ?? "");
      if (range === embeddedVersion) return await installEmbedded(dataDir, builtinCandidate);
    }
  }
  return await installFromRegistry(dataDir, opts.spec, opts.id, registryUrl);
}

/** One installed plugin with a newer version available. */
export interface PluginUpdate {
  /** Plugin id (directory name) */
  id: string;
  /** The npm package name it was installed from (from the sidecar) */
  name: string;
  /** Installed version */
  from: string;
  /** Newest registry version, or null when the install is already at or above it */
  to: string | null;
}

/** Newest registry version for every sidecar'd install (embedded installs are never upgraded behind their operator). */
export async function resolvePluginUpdates(
  dataDir: string,
  opts: { id?: string; registryUrl?: string } = {},
): Promise<PluginUpdate[]> {
  const out: PluginUpdate[] = [];
  for (const p of await listInstalled(dataDir)) {
    if (opts.id !== undefined && p.id !== opts.id) continue;
    const record = await readInstallRecord(dataDir, p.id);
    if (!record) continue;
    try {
      const latest = await resolvePackageVersion(record.name, undefined, opts.registryUrl ?? DEFAULT_REGISTRY_URL);
      out.push({
        id: p.id,
        name: record.name,
        from: record.version,
        to: semverLt(record.version, latest.version) ? latest.version : null,
      });
    } catch (err) {
      // "could not ask" is reported, never guessed at — but it is not an update.
      pluginLog().warn(`update check for '${record.name}' failed: ${describe(err)}`);
    }
  }
  return out;
}

/**
 * Re-installs any built-in whose on-disk copy differs from this build's.
 *
 * The binary and its built-ins ship together, so a stale on-disk copy of a
 * built-in is never something a user chose: it means the agent was upgraded
 * underneath it. A plugin this build carries no copy of is left strictly
 * alone, because overwriting a third-party plugin from nowhere would be data
 * loss rather than a refresh.
 *
 * A copy with an install record is left alone too, and that is the same
 * reasoning applied to the NEW case phase 3 opened: an embedded version that
 * differs from a registry-pinned one is not the agent having been upgraded
 * underneath the plugin, it is the operator having chosen that version, and
 * reinstalling the embedded copy would silently undo the install (and drop
 * the sidecar that says so).
 * @returns the ids that were refreshed, id-sorted
 */
export async function refreshStaleBuiltIns(dataDir: string): Promise<string[]> {
  const refreshed: string[] = [];
  for (const installed of await listInstalled(dataDir)) {
    const source = await readBuiltIn(installed.id);
    if (!source) continue;
    if (await readInstallRecord(dataDir, installed.id)) {
      // Only logged for built-in ids, where the embedded copy was RIGHT
      // THERE and this pass is what would have clobbered it.
      sink.info(`skipped '${installed.id}': registry-installed ${installed.version} left alone`);
      continue;
    }
    // No guard around this parse, deliberately. `readBuiltIn` returned these
    // bytes only after parsing them itself, so a throw here is impossible and
    // a try around it would be unreachable code claiming to prevent something.
    // The parse that CAN throw is the one inside `readBuiltIn`, and it is
    // guarded there, where a malformed built-in makes it answer null instead
    // of ending this loop.
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
      sink.warn(`could not refresh built-in plugin "${installed.id}", keeping the installed copy`, err);
    }
  }
  return refreshed.sort();
}
