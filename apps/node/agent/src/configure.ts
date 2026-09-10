import { type AgentConfig, loadConfig, saveConfig } from "./config.js";
import { normalizeServer } from "./enroll.js";

/**
 * `subshell configure` — repoint an already-enrolled node at a different
 * control-plane address without re-enrolling.
 *
 * This exists because `enroll` is the wrong tool for "the server moved". It
 * overwrites `config.json` unconditionally, mints a SECOND node row on the
 * plane, spends a single-use 24-hour setup key, and discards the node key
 * whose only home was that file. None of that is what someone changing an
 * address wants, and the address is exactly what changes when a control plane
 * stops being reachable as `localhost` and starts being reachable as a LAN
 * name — the same move that makes the server's own `TRUSTED_ORIGINS` matter.
 *
 * The identity is untouched: `nodeId`, `nodeKey` and the pinned
 * `controlPublicKey` all survive, so the plane still sees the same node.
 *
 * **Deliberately does NOT rename.** `config.json`'s `name` reaches the control
 * plane in exactly one place — the enroll POST body — and is absent from
 * `readyEvent` and the inventory event, so writing it here would change only
 * what local `subshell status` prints while the Nodes page kept the old name
 * forever. Renaming a node is the plane's own job
 * (`PATCH /api/nodes/:id`, the Nodes page); a flag that looked like it
 * renamed and did not is worse than no flag.
 */

/** What `configure` may change. */
export interface ConfigureOpts {
  /** `--server`: the control plane's new base URL (http(s), trailing slashes stripped). */
  server: string;
  /**
   * `--registry-url`: npm registry base for plugin installs (phase 3).
   * Optional; absent leaves whatever mirror is already configured untouched.
   */
  registryUrl?: string;
}

/**
 * Validate and store-normalize a `--registry-url` value by component.
 *
 * Deliberately NOT `normalizeServer`: that one lower-cases the scheme because
 * `wsUrlFor`'s `replace(/^http/, "ws")` is case-sensitive, and a registry URL
 * never feeds that. Here the value is stored as typed minus paste padding and
 * trailing slashes, because a mirror legitimately lives under a path prefix
 * (`https://mirror.internal/registry`) that canonicalization must not eat.
 * The scheme must still be http(s) and the whole thing must parse — integrity
 * comes from whichever host is named (spec 2026-09-09-registry §2.7), so the
 * operator must at least be naming a real host.
 */
function normalizeRegistry(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`--registry-url must be a full URL (e.g. https://mirror.internal:4873), got '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--registry-url must be http(s), got '${raw}'`);
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Apply a repoint to the stored config.
 *
 * Validates BEFORE reading and writes exactly once, so a refusal leaves the
 * file byte-identical — the config holds the only copy of the node key, and a
 * half-applied rewrite of it is unrecoverable.
 *
 * When the address changes, `nodeWsUrl` is REMOVED. That field is what the old
 * plane reported about itself at enroll (ledger 17c) and `resolveWsUrl`
 * prefers it over any derivation — so carrying it forward would leave the
 * daemon dialing the old host while `serverUrl` named the new one, a
 * divergence no surface displays. Cleared, the daemon derives from the address
 * actually configured; a plane behind a proxy subpath re-reports its own ws URL
 * on the next enroll.
 *
 * `--registry-url` (phase 3) writes ONLY the mirror key, and the same
 * validate-before-read rule covers it: both URLs are checked before the file
 * is opened, so a refusal on either leaves the config byte-identical. Absent,
 * a configured mirror survives the repoint — the registry outlives the
 * address that happened to be configured when it was set.
 *
 * @param opts - the parsed `--server` and optional `--registry-url` flags
 * @returns the config as it was written (the node key included — callers must
 *   never print it; the CLI prints only the address)
 * @throws when a URL is unusable, or there is no config to repoint (the
 *   message points at `enroll`)
 */
export async function runConfigure(opts: ConfigureOpts): Promise<AgentConfig> {
  // Normalized first, so an unusable URL is refused without touching the file.
  const serverUrl = normalizeServer(opts.server);
  const registryUrl = opts.registryUrl === undefined ? undefined : normalizeRegistry(opts.registryUrl);

  const current = await loadConfig();
  const next: AgentConfig = { ...current, serverUrl };
  if (serverUrl !== current.serverUrl) {
    delete next.nodeWsUrl;
  }
  if (registryUrl !== undefined) next.registryUrl = registryUrl;
  await saveConfig(next);
  return next;
}
