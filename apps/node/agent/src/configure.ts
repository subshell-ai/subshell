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
 * @param opts - the parsed `--server` flag
 * @returns the config as it was written (the node key included — callers must
 *   never print it; the CLI prints only the address)
 * @throws when the URL is unusable, or there is no config to repoint (the
 *   message points at `enroll`)
 */
export async function runConfigure(opts: ConfigureOpts): Promise<AgentConfig> {
  // Normalized first, so an unusable URL is refused without touching the file.
  const serverUrl = normalizeServer(opts.server);

  const current = await loadConfig();
  const next: AgentConfig = { ...current, serverUrl };
  if (serverUrl !== current.serverUrl) {
    delete next.nodeWsUrl;
  }
  await saveConfig(next);
  return next;
}
