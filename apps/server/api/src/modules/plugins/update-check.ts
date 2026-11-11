import { resolvePluginUpdates } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { localPluginReports } from "@/modules/plugins/store.js";

/**
 * Whether the instance's installed plugins have newer versions on its
 * configured registry (spec § plugin updates).
 *
 * The answer costs one packument request per sidecar'd plugin, so it is
 * memoised for {@link PLUGIN_UPDATE_MEMO_MS} and rebuilt only by the
 * Re-check route, which exists precisely because that cost is real: a GET
 * that reached the network on every render would spend a registry's rate
 * limit on page opens nobody asked for.
 *
 * **The comparison is against the copy IN USE, not the bytes on disk.** The
 * report already answers which copy won (a built-in answers from the bundle
 * unless a newer installed copy loads), so its `version` is what an offer
 * must be measured against — the resolver takes it as a callback and never
 * imports plugin code itself.
 *
 * **A failure is a row, not silence.** One unreachable registry must not
 * hide the rest: `updates` carries the offers (`to` always concrete) and
 * `errors` carries what could not be checked, each naming its plugin.
 */

/** One plugin with a newer version on the registry. */
export interface PluginOffer {
  /** Plugin id */
  id: string;
  /** The npm package name the bytes came from */
  name: string;
  /** The version in use now */
  from: string;
  /** The newest registry version, always newer than `from` */
  to: string;
}

/** One plugin whose registry check failed. */
export interface PluginCheckError {
  /** Plugin id */
  id: string;
  /** The npm package name the bytes came from */
  name: string;
  /** Why the registry could not be asked */
  message: string;
}

/** `GET/POST /api/plugins/updates*` — the view the instance page renders. */
export interface PluginUpdatesView {
  /** Newer versions available */
  updates: PluginOffer[];
  /** Plugins the registry could not be asked about */
  errors: PluginCheckError[];
  /** Epoch milliseconds when this answer was collected */
  checkedAt: number;
}

/**
 * How long an answer is reused. Fifteen minutes matches the server's own
 * update memo: long enough that a page left open cannot spend a rate limit,
 * short enough that a fresh release shows up while the operator is still
 * thinking about it.
 */
export const PLUGIN_UPDATE_MEMO_MS = 15 * 60_000;

/**
 * The last answer, keyed by the registry it was collected from.
 *
 * The registry is part of the key because changing the mirror is a change of
 * QUESTION, not a reason to wait out a TTL for a different server's answer.
 */
let memo: { at: number; registryUrl: string; view: PluginUpdatesView } | null = null;

/**
 * Build the update view, or answer the memoised one.
 * @param opts.force - drop the memo and read the registry again (the
 *   Re-check button's act)
 * @param opts.registryUrl - the registry to ask, normally the configured
 *   `SUBSHELL_PLUGIN_REGISTRY_URL`
 */
export async function collectPluginUpdates(opts: { force: boolean; registryUrl: string }): Promise<PluginUpdatesView> {
  const now = Date.now();
  if (!opts.force && memo !== null && memo.registryUrl === opts.registryUrl && now - memo.at < PLUGIN_UPDATE_MEMO_MS) {
    return memo.view;
  }

  // The report's version is the EFFECTIVE one — the copy that actually runs.
  const reports = await localPluginReports();
  const effective = new Map(reports.map((r) => [r.id, r.version]));
  const rows = await resolvePluginUpdates(SUBSHELL_SERVER_DATA_DIR, {
    registryUrl: opts.registryUrl,
    effectiveVersion: (id) => effective.get(id),
  });

  const view: PluginUpdatesView = {
    updates: rows.flatMap((r) =>
      r.error === undefined && r.to !== null ? [{ id: r.id, name: r.name, from: r.from, to: r.to }] : [],
    ),
    errors: rows.flatMap((r) => (r.error !== undefined ? [{ id: r.id, name: r.name, message: r.error }] : [])),
    checkedAt: now,
  };
  memo = { at: now, registryUrl: opts.registryUrl, view };
  return view;
}

/**
 * Drop the memo. For tests, and for anything that knows the store or the
 * registry changed underneath this process.
 * @internal
 */
export function clearPluginUpdateMemo(): void {
  memo = null;
}
