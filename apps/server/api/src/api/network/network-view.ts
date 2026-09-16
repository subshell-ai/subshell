import type { NetworkContext, NetworkPluginEntry, NetworkStatus, PluginPlatform } from "@internal/pane-runtime";
import type { Static } from "elysia";
import { isSupportedHere, networkDeps, readNetworkStatus } from "@/api/network/network-gate.js";
import type { NetworkRowSchema } from "@/api/network/schemas.js";
import { networkContext, publishStateVisible, readNetworkState } from "@/services/network/state.js";
import { processState } from "@/services/network/supervisor.js";

/**
 * One network plugin as the page renders it, and the list of them.
 *
 * Its own module because FOUR routes answer with a row — the list, the
 * settings write, and (inside their terminal frame) the two streaming acts —
 * and a row assembled twice is a row that comes out different depending on
 * which call you made.
 */

/** The row shape, named once so handlers and helpers agree on it. */
export type NetworkRow = Static<typeof NetworkRowSchema>;

/** What a row needs beyond the plugin itself; gathered once per request. */
export interface RowInputs {
  /** Whether the instance offers this plugin at all. */
  enabled: boolean;
  /** This host's platform, so a list of six rows asks once. */
  platform: PluginPlatform;
  /**
   * A status already in hand, when the caller has one.
   *
   * An act passes the status it just read back fresh, so the row it answers
   * with describes the machine AFTER the act rather than re-probing (and
   * re-spawning a CLI) a second time.
   */
  status?: NetworkStatus;
}

/**
 * Builds one row.
 *
 * `status` is present only for a plugin that is enabled AND supported here: an
 * unsupported plugin is never probed, because probing it means running a
 * vendor CLI the manifest says cannot be driven on this OS, and a disabled one
 * is not offered at all. A row without `status` is what the page renders as
 * "not available on this platform" — the manifest data around it is enough to
 * say so, and to print the install command, without any plugin code running.
 */
export async function buildNetworkRow(entry: NetworkPluginEntry, inputs: RowInputs): Promise<NetworkRow> {
  const id = entry.manifest.id;
  const network = entry.manifest.network;
  const supported = network !== undefined && isSupportedHere(network, inputs.platform);
  const [state, ctx] = await Promise.all([readNetworkState(id), networkContext(id, entry)]);
  const fields = entry.plugin.settingsFields?.() ?? [];

  let status = inputs.status;
  if (status === undefined && inputs.enabled && supported) {
    status = await readNetworkStatus(entry, ctx);
  }
  // The host's record is the only witness for a `publishImplicit` plugin
  // (NetBird): its publish left nothing the daemon can be re-asked about.
  // Nothing else is upgraded — see `publishStateVisible`.
  if (status !== undefined) status = publishStateVisible(network, state.published, status);
  const process = processState(id) ?? undefined;

  return {
    id,
    name: entry.manifest.name,
    description: entry.manifest.description,
    ...(entry.manifest.icon ? { icon: entry.manifest.icon } : {}),
    exposure: network?.exposure ?? "private",
    platforms: network?.platforms ?? [],
    supported,
    enabled: inputs.enabled,
    interactiveLogin: network?.interactiveLogin === true,
    ...(entry.manifest.install
      ? { install: { command: entry.manifest.install.command, docsUrl: entry.manifest.install.docsUrl } }
      : {}),
    // THIS platform's steps only. The manifest carries a set per platform, and
    // rendering the other one's `sudo` lines to copy is how an operator runs a
    // Linux command on a Mac.
    //
    // `group` is forwarded verbatim rather than resolved into sections here:
    // which steps are alternatives to which is the manifest's fact, and a page
    // that received pre-grouped arrays could no longer render the ungrouped
    // flat sequence every other plugin's steps are.
    labels: entry.manifest.network?.labels ?? {},
    privileged: (network?.privileged?.[inputs.platform] ?? []).map((step) => ({
      label: step.label,
      command: step.command,
      ...(step.docsUrl ? { docsUrl: step.docsUrl } : {}),
      ...(step.group ? { group: step.group } : {}),
    })),
    settingsFields: fields.map((field) => ({
      key: field.key,
      label: field.label,
      ...(field.description ? { description: field.description } : {}),
      type: field.type,
      ...(field.choices ? { choices: field.choices } : {}),
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    })),
    settings: settingsView(fields, ctx),
    ...(status ? { status } : {}),
    ...(process ? { process } : {}),
    published: state.published,
  };
}

/**
 * The settings object as a response may carry it.
 *
 * A `secret` field reports `{ set }` and NEVER its value — the host's secret
 * store is write-only by design, and a read that returned the value would put
 * a credential in a response body, a log line and a browser cache in one move.
 * Ordinary fields carry what was stored; a field with nothing stored is
 * omitted, so "unset" and "set to the empty string" stay distinguishable.
 */
function settingsView(
  fields: { key: string; type: string }[],
  ctx: NetworkContext,
): Record<string, string | { set: boolean }> {
  const view: Record<string, string | { set: boolean }> = {};
  for (const [key, value] of Object.entries(ctx.settings)) view[key] = value;
  for (const field of fields) {
    if (field.type === "secret") view[field.key] = { set: ctx.secrets.has(field.key) };
  }
  return view;
}

/**
 * Every installed, loadable network plugin, id-sorted.
 *
 * INSTALLED and LOADABLE, which is narrower than either source alone: a
 * built-in this build compiles in but the store has not seeded is not offered
 * (nothing is installed to act on), and an installed plugin whose code will
 * not load has no row here — it keeps its row on `/api/plugins`, carrying the
 * loader's own message, which is the page that can say why.
 */
export async function listNetworkRows(): Promise<NetworkRow[]> {
  const deps = networkDeps();
  const [installed, enabled] = await Promise.all([deps.installed(), deps.enabled()]);
  const enabledIds = new Set(enabled.map((r) => r.id));
  const installedIds = new Set(installed.map((r) => r.id));
  const platform = deps.platform();
  const entries = deps
    .plugins()
    .filter((e) => installedIds.has(e.manifest.id))
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return await Promise.all(
    entries.map((entry) => buildNetworkRow(entry, { enabled: enabledIds.has(entry.manifest.id), platform })),
  );
}
