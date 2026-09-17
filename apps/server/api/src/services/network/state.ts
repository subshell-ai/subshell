import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NetworkStatus } from "@internal/pane-runtime";
import {
  createPluginSecrets,
  type NetworkAddress,
  type NetworkContext,
  type NetworkPluginEntry,
  pluginStateDir,
} from "@internal/pane-runtime";
import { SERVER_PORT, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/**
 * The host's record of what one network plugin is doing on this instance.
 *
 * **The plugin holds none of this**, and that is the whole point of keeping it
 * here: a `NetworkPlugin` is asked for its supervised process, its guard and
 * its addresses again on every boot, from a {@link NetworkContext} the host
 * builds out of these rows — so a plugin reloaded after an upgrade behaves
 * identically to one that has been running since boot, and a plugin that
 * remembered a port would be wrong the first time an admin changed it.
 *
 * It is a FILE rather than a table because it is per-plugin, schemaless by
 * construction (a plugin's settings are its own vocabulary) and shares the
 * lifetime of the plugin's secrets, which already live under
 * `plugins-state/<id>/`. A migration per installed plugin is not a thing this
 * repo can express, and `plugin_state` is deliberately one boolean.
 *
 * 0600 in the 0700 directory `pluginStateDir` describes, because `settings`
 * can hold things an operator would not want world-readable even though the
 * genuinely secret fields live in the secret store beside it.
 */

/** Directory mode: only this user may traverse it. */
const DIR_MODE = 0o700;

/** File mode: only this user may read it. */
const FILE_MODE = 0o600;

/** File name inside `<dataDir>/plugins-state/<id>/`. */
const STATE_FILE = "network.json";

/** What the host remembers about one network plugin between calls. */
export interface NetworkPluginState {
  /**
   * The plugin's non-secret settings, exactly as an admin stored them.
   *
   * Secret-typed fields never reach here: those go to the plugin's secret
   * store, and this file would otherwise be a second, weaker copy of one.
   */
  settings: Record<string, string>;
  /** True when an admin published this server on this network and has not unpublished. */
  published: boolean;
  /**
   * The `SERVER_PORT` the publish was made against, or null when unpublished.
   *
   * Kept because a publish is a statement about a PORT — a tunnel points at
   * one, an address names one — so a port change between two boots invalidates
   * it. Boot compares this against the running port and re-publishes when they
   * disagree (`prepare.ts`), which is the one thing the plugin cannot do for
   * itself, having been given no memory.
   */
  port: number | null;
  /**
   * The last addresses this host was known to have on that network.
   *
   * Written by every status read that answers `joined` or `published`, by a
   * publish (its result), and cleared when the host leaves the network or the
   * plugin is disabled or uninstalled. Until 2026-09-16 this said "as the last
   * publish reported"; it widened because the trusted-origin registry derives
   * from it (`services/network/origins.ts`) and a private network's addresses
   * are trusted from membership, not from a publish.
   */
  addresses: NetworkAddress[];
  /** ISO 8601 stamp of that publish, for the UI. */
  publishedAt?: string;
}

/** The state of a plugin nothing has ever been recorded for. */
function emptyState(): NetworkPluginState {
  return { settings: {}, published: false, port: null, addresses: [] };
}

/**
 * `<dataDir>/plugins-state/<id>/network.json` — the record's path, for tests
 * that assert it was or was not rewritten.
 */
export function networkStatePath(pluginId: string): string {
  return join(pluginStateDir(SUBSHELL_SERVER_DATA_DIR, pluginId), STATE_FILE);
}

/**
 * Serializes this process's writes per plugin.
 *
 * Every write is a read-merge-write, so two overlapping ones (an admin saving
 * settings while boot reconciles a changed port) would lose whichever read
 * first. A promise chain per id is enough: the file has exactly one writer
 * process, the control plane.
 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Reads one plugin's recorded state.
 *
 * NEVER throws, and that is deliberate rather than defensive: every caller is
 * on a path that must still work when the file is absent (a plugin nobody has
 * configured), truncated (a crash mid-write, though the rename below makes
 * that unreachable) or hand-edited. The honest answer in all three cases is
 * "this plugin has published nothing", which is also the safe one — a boot
 * that cannot read the file arms no process and installs no guard.
 * @param pluginId - whose state to read; each plugin sees only its own
 */
export async function readNetworkState(pluginId: string): Promise<NetworkPluginState> {
  let text: string;
  try {
    text = await readFile(networkStatePath(pluginId), "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyState();
    const row = parsed as Partial<NetworkPluginState>;
    return {
      // Field by field rather than a spread: a hand-edited file that dropped
      // `addresses` would otherwise hand `undefined` to code typed to receive
      // an array, which fails somewhere far from here.
      settings: isStringMap(row.settings) ? row.settings : {},
      published: row.published === true,
      port: typeof row.port === "number" && Number.isInteger(row.port) ? row.port : null,
      addresses: Array.isArray(row.addresses) ? row.addresses.filter(isAddress) : [],
      ...(typeof row.publishedAt === "string" ? { publishedAt: row.publishedAt } : {}),
    };
  } catch {
    return emptyState();
  }
}

/** True when a parsed value is usable as the settings map. */
function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/** True when a parsed value carries every field an address is rendered from. */
function isAddress(value: unknown): value is NetworkAddress {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<NetworkAddress>;
  return (
    typeof row.url === "string" &&
    (row.scheme === "https" || row.scheme === "http") &&
    typeof row.label === "string" &&
    typeof row.secureContext === "boolean"
  );
}

/**
 * Merges a patch into one plugin's state and writes it atomically.
 *
 * Shallow merge: every field is replaced wholesale, including `settings`, so a
 * caller clearing a setting passes the map it wants rather than a deletion
 * vocabulary this file would have to invent.
 *
 * Temp file + `rename(2)`, with the mode set before the rename — the same
 * shape `createPluginSecrets` uses, and for the same reason: there is no
 * window in which the final path exists at the umask's mode, and no window in
 * which it holds half a document.
 * @param pluginId - whose state to write
 * @param patch - the fields to change; anything absent is kept
 * @returns the state as it now stands on disk
 */
export async function writeNetworkState(
  pluginId: string,
  patch: Partial<NetworkPluginState>,
): Promise<NetworkPluginState> {
  const run = async (): Promise<NetworkPluginState> => {
    const next: NetworkPluginState = { ...(await readNetworkState(pluginId)), ...patch };
    const dir = pluginStateDir(SUBSHELL_SERVER_DATA_DIR, pluginId);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    // `mkdir` honours its mode only when it CREATES the directory, and a data
    // dir restored from a backup or written by an older build may carry
    // anything. Repairing on every write is cheap.
    await chmod(dir, DIR_MODE);
    const target = join(dir, STATE_FILE);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, target);
    return next;
  };
  // Chained on the previous write for this plugin, and the chain survives a
  // rejection so one failed write cannot wedge every later one.
  const queued = (writeQueues.get(pluginId) ?? Promise.resolve()).then(run, run);
  writeQueues.set(
    pluginId,
    queued.catch(() => {}),
  );
  return await queued;
}

/**
 * Forgets everything the host recorded for one plugin.
 *
 * Called when a plugin is uninstalled. Deliberately does NOT touch the secret
 * store beside it: that is the installer's business, and conflating "this
 * plugin publishes nothing" with "destroy this plugin's credentials" would
 * make an unpublish and an uninstall the same act.
 */
export async function clearNetworkState(pluginId: string): Promise<void> {
  await rm(networkStatePath(pluginId), { force: true });
}

/**
 * Builds the context one plugin is handed on every call.
 *
 * `secrets.has` is SYNCHRONOUS in the contract, while the store answers from
 * the filesystem — so the set of present names is resolved HERE, once, and the
 * returned predicate closes over it. That is not only a type accommodation: a
 * plugin asking "am I configured" twice inside one `status()` call must get
 * the same answer both times, and a per-call `statSync` would let a rotation
 * land between them.
 *
 * Only fields the plugin DECLARED as `secret` are probed. A plugin that never
 * declared one sees an empty set rather than a store the host guessed at.
 * @param pluginId - whose context this is
 * @param entry - the loaded plugin and its manifest, for `settingsFields()`
 */
export async function networkContext(pluginId: string, entry: NetworkPluginEntry): Promise<NetworkContext> {
  const state = await readNetworkState(pluginId);
  const secrets = createPluginSecrets(SUBSHELL_SERVER_DATA_DIR, pluginId);
  const declared = (entry.plugin.settingsFields?.() ?? []).filter((f) => f.type === "secret").map((f) => f.key);
  const present = new Set<string>();
  for (const name of declared) {
    // A name a plugin declared may not be a usable file name; `has` throws on
    // one rather than inventing a path. An undeclarable secret is simply not
    // set, which is what a plugin asking about it needs to hear.
    try {
      if (await secrets.has(name)) present.add(name);
    } catch {
      /* not a usable secret name — treat as unset */
    }
  }
  return {
    // The RUNNING port, never the recorded one: the recorded port says what
    // the last publish was made against, and the difference between the two is
    // exactly what boot reconciles.
    port: SERVER_PORT,
    settings: state.settings,
    secrets: { has: (name: string) => present.has(name) },
  };
}

/**
 * The status the page should see, once the host's own record is consulted.
 *
 * A plugin whose manifest declares `publishImplicit` cannot observe its own
 * published state — its publish IS the join, and no vendor command will
 * later answer "and are you serving?" For those, a host record saying
 * published upgrades `joined` to `published`, which is what the Networking
 * row, the wizard chip and the boot report must all agree on.
 *
 * Everything else passes through untouched. An unconditional upgrade would
 * tell a Tailscale whose `serve` was reset outside this app that it is
 * still publishing, and a confident wrong state is worse than an honest
 * partial one.
 */
export function publishStateVisible(
  manifest: { publishImplicit?: boolean } | undefined,
  recordPublished: boolean,
  status: NetworkStatus,
): NetworkStatus {
  if (!recordPublished || manifest?.publishImplicit !== true || status.state !== "joined") return status;
  return { ...status, state: "published" };
}
