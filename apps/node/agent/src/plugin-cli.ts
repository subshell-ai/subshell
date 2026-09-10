import {
  builtInIds,
  installPlugin,
  listInstalled,
  readInstallRecord,
  resolvePluginUpdates,
  uninstallPlugin,
} from "@internal/pane-runtime";
import type { CliResult, ParsedArgs, RunDeps } from "./cli.js";
import { loadConfig } from "./config.js";

/**
 * The `subshell plugin list|install|uninstall|update` verbs (spec 2026-09-09
 * plugin-architecture §8.1) — a lifeboat for hosts with no reachable control
 * plane, driving the SAME pane-runtime door the signed commands use, so there
 * is one install path to audit, not two.
 *
 * Three shapes the rest of the CLI keeps separate, and this file keeps too:
 *
 * - **`--json` is the machine contract** and lives only on the two views
 *   (`list`, `update`). stdout carries ONLY the JSON: on `update` the restart
 *   note rides stderr, so `subshell plugin update --json | jq` never chokes
 *   on prose.
 * - **Human output is one line per plugin**, id first, so it greps and it
 *   columns.
 * - **Embedded first is not re-implemented here.** `installPlugin` makes the
 *   §2.5 source decision (and a built-in id with no version pin NEVER hits
 *   the network — pinned by the trap test); this file only decides which of
 *   the frozen pane-runtime calls to make.
 *
 * Config is mandatory: every verb resolves `dataDir` (where the plugin set
 * lives) from it, and a missing config exits 1 pointing at `subshell enroll`,
 * the `status` rule. `deps.plugin` overrides both the data dir and the
 * registry URL and exists for tests only.
 */

/** The restart line, verbatim from the daemon's plugin_install log (basics.ts): a loaded module is not evicted, so new bytes act on restart. */
const RESTART_NOTE = "note: a running agent keeps its loaded copy until restart";

/** One `plugin list --json` row. Key order is the contract; the optional pairs appear only when they apply. */
interface PluginRow {
  /** Plugin id (directory name) */
  id: string;
  /** The installed package version ("" on a broken directory) */
  version: string;
  /** Why it cannot be loaded, when it cannot */
  broken?: string;
  /** The npm package the bytes were installed from; absent for embedded copies (no sidecar) */
  package?: string;
  /** The exact registry version recorded in the sidecar */
  packageVersion?: string;
}

/** Runs one `plugin <verb>`; throws are mapped to exit 1 by the caller, exactly as the other commands'. */
export async function runPlugin(parsed: ParsedArgs, deps: RunDeps): Promise<CliResult> {
  // loadConfig's own throw names `subshell enroll` (the `status` rule): the
  // plugin set lives in the data dir only an enrollment defines.
  const cfg = await loadConfig();
  const dataDir = deps.plugin?.dataDir ?? cfg.dataDir;
  // Per-invocation read, matching the config's role everywhere else: the
  // mirror knob applies the moment the next command runs.
  const registryUrl = deps.plugin?.registryUrl ?? cfg.registryUrl;
  switch (parsed.sub) {
    case "list":
      return await pluginList(dataDir, parsed.flags.json === "1");
    case "install":
      // parseArgs guarantees the positional for install; the empty fallback
      // only exists so a future caller cannot silently install "" (pane-runtime
      // refuses it as an invalid package name).
      return await pluginInstall(dataDir, parsed.arg ?? "", registryUrl);
    case "uninstall":
      return await pluginUninstall(dataDir, parsed.arg ?? "");
    case "update":
      return await pluginUpdate(dataDir, parsed.arg, registryUrl, parsed.flags.json === "1");
  }
  // Unreachable through parseArgs (it pins `sub` to the four verbs); shaped
  // like the `service` case's belt-and-braces so a fifth verb added to
  // SUBCOMMANDS without a handler here reads as a refusal, not a silent 0.
  return { code: 2, out: "", err: `subshell: unknown plugin subcommand '${parsed.sub ?? ""}'\n` };
}

/** `list`: the installed set with its origins. A VIEW: always exit 0. */
async function pluginList(dataDir: string, json: boolean): Promise<CliResult> {
  const rows: PluginRow[] = [];
  for (const p of await listInstalled(dataDir)) {
    const record = await readInstallRecord(dataDir, p.id);
    rows.push({
      id: p.id,
      version: p.version,
      ...(p.broken === undefined ? {} : { broken: p.broken }),
      ...(record === null ? {} : { package: record.name, packageVersion: record.version }),
    });
  }
  if (json) return { code: 0, out: `${JSON.stringify(rows, null, 2)}\n`, err: "" };
  if (rows.length === 0) return { code: 0, out: "no plugins installed\n", err: "" };
  const lines = rows.map((r) => {
    const notes = [
      r.broken === undefined ? undefined : `(broken: ${r.broken})`,
      // The spec calls this the package column: where a non-embedded copy
      // came from, which is the fact `update` acts on and prose otherwise hides.
      r.package === undefined ? undefined : `(from ${r.package}@${r.packageVersion})`,
    ].filter((s): s is string => s !== undefined);
    return `${r.id} ${r.version || "?"}${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`;
  });
  return { code: 0, out: `${lines.join("\n")}\n`, err: "" };
}

/** `install <name|@scope/pkg[@version]>`: the §2.5 embedded-first door, then one honest line about what landed. */
async function pluginInstall(dataDir: string, arg: string, registryUrl: string | undefined): Promise<CliResult> {
  // Captured BEFORE the install, because "was this id already there" is the
  // only moment that question has an answer, and it is what makes the restart
  // note true (a fresh copy replaces nothing a running agent has loaded).
  const before = new Set((await listInstalled(dataDir)).map((p) => p.id));
  // Passing the id for a built-in is the command-frame shape (the signed
  // `plugin_install` carries id + spec); pane-runtime's facade decides the
  // source either way. A scoped spec is not a built-in id, so it goes as spec
  // alone and lands under whatever id its manifest declares.
  const builtins = await builtInIds();
  const installed = await installPlugin(dataDir, {
    id: builtins.includes(arg) ? arg : undefined,
    spec: arg,
    registryUrl,
  });
  const record = await readInstallRecord(dataDir, installed.id);
  const line = `installed ${installed.id}@${installed.version}${record === null ? "" : ` (${record.name})`}`;
  return { code: 0, out: `${line}${before.has(installed.id) ? `\n${RESTART_NOTE}` : ""}\n`, err: "" };
}

/** `uninstall <id>`: remove it. Already-absent is the SAME SUCCESS, not an error, exactly as the signed command answers it. */
async function pluginUninstall(dataDir: string, id: string): Promise<CliResult> {
  // An unsafe id throws inside `uninstallPlugin` (assertSafeId, before any
  // filesystem touch) and the caller maps it to exit 1.
  const removed = await uninstallPlugin(dataDir, id);
  return { code: 0, out: removed ? `uninstalled ${id}\n` : `${id} was not installed\n`, err: "" };
}

/**
 * `update [<id>]`: re-resolve the sidecar'd installs and reinstall only where
 * newer.
 *
 * The array from `resolvePluginUpdates` IS the answer, and its two silences
 * are load-bearing: embedded copies are not in it (never upgraded from a
 * registry behind their operator's back), and a FAILED check is not in it
 * either (pane-runtime warn-logs it and omits the plugin, so "could not ask"
 * never renders as "up to date"). `to: null` means already at or above
 * latest. This file must not invent rows for the omissions, and does not.
 */
async function pluginUpdate(
  dataDir: string,
  id: string | undefined,
  registryUrl: string | undefined,
  json: boolean,
): Promise<CliResult> {
  const updates = await resolvePluginUpdates(dataDir, { ...(id === undefined ? {} : { id }), registryUrl });
  let moved = 0;
  for (const u of updates) {
    if (u.to === null) continue;
    // Same door as `install`, with the resolved pin: exact version, no
    // floating, so the bytes that land are the bytes the check named.
    await installPlugin(dataDir, { spec: `${u.name}@${u.to}`, registryUrl });
    moved += 1;
  }
  if (json) {
    // stdout is ONLY the JSON; the note is prose, so it goes to stderr.
    return { code: 0, out: `${JSON.stringify(updates, null, 2)}\n`, err: moved > 0 ? `${RESTART_NOTE}\n` : "" };
  }
  if (updates.length === 0) {
    // Not an error, and worth saying: on a seeded node an empty answer would
    // otherwise read as a command that did nothing at all.
    return { code: 0, out: "no updates found (built-in plugins update with the agent, not the registry)\n", err: "" };
  }
  const lines = updates.map((u) =>
    u.to === null ? `${u.id} ${u.from} (already at latest)` : `${u.id} ${u.from} -> ${u.to} (updated)`,
  );
  return { code: 0, out: `${lines.join("\n")}${moved > 0 ? `\n${RESTART_NOTE}` : ""}\n`, err: "" };
}
