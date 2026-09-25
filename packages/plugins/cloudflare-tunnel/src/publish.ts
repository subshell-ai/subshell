import type {
  NetworkContext,
  PluginHost,
  PublishOutcome,
  PublishRefusal,
  SupervisedProcessSpec,
} from "@subshell-ai/plugin-api";
import { readSettings, resolveBinary, TOKEN_SECRET, tunnelAddress } from "./cli.js";
import { accessCovers } from "./preflight.js";

/**
 * Starting the tunnel, in the only order that is safe (spec 2026-09-15 § 6):
 * settings complete → the Access pre-flight → the declarations.
 *
 * What publish returns is not a result of work it did. It is a description of
 * the work the HOST must now do: a `process` to supervise and an address that
 * only means something once that process is up. The guard is deliberately
 * absent from this outcome — `requestGuard(ctx)` is its single source, asked
 * again by the route right after this and again at every boot
 * (`services/network/resolve-guard.ts`).
 */
export async function publishTunnel(host: PluginHost, ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
  // (a) Settings before anything. The route runs the same check on the way
  // in (`configurationRefusal`), but the boot reconcile calls `publish`
  // directly, and a publish is where the sentence belongs either way.
  const settings = readSettings(ctx);
  if (settings === null) {
    return { refused: { text: "Set the hostname, team domain and application AUD before publishing." } };
  }
  if (!ctx.secrets.has(TOKEN_SECRET)) {
    return {
      refused: { text: "Paste the tunnel token before publishing: the tunnel runs on its connector's token." },
    };
  }

  // (b) The Access pre-flight, BEFORE anything runs. Failing closed is the
  // whole contract of a `public-with-gate` exposure: an unreachable hostname
  // or a broken check refuses exactly like a bare one, because both mean the
  // thing in front of this server is not known to be Access.
  const answer = await accessCovers(settings);
  if (!answer.covered) {
    return { refused: { text: answer.reason } };
  }

  // (c) The declarations. Resolved here (this call is async) so the publish
  // arms a spec whose command is the absolute path the host's own ladder
  // found; `supervisedProcess` re-derives the same spec at every boot.
  const binary = await resolveBinary(host);
  if (!binary) {
    return { refused: { text: "cloudflared is not installed on this machine, so there is no tunnel to start." } };
  }

  return { addresses: [tunnelAddress(settings.hostname)], process: tunnelProcessSpec(binary) };
}

/**
 * The one child this plugin needs, as the contract describes it.
 *
 * **The token is nowhere in here, and nowhere near the argv.** `args` are the
 * two words that run a token-authenticated connector, and `secretEnv` names
 * the secret for the host to hydrate into the child's `TUNNEL_TOKEN`
 * environment at spawn (`services/network/supervisor.ts`, the only place the
 * value is ever read). `ps` on this host shows a command line with no
 * credential in it — the § 4.4 design, exercised for the first time.
 *
 * `--no-autoupdate` is not tidiness: a connector that updates its own binary
 * replaces the file the supervisor is tracking, mid-supervision, with one the
 * operator never chose. Updates belong to this product's update channel.
 *
 * NO `readyPattern`, on purpose and because § 10.5 is unmeasured: the exact
 * line `cloudflared` prints when its first connection registers was never
 * observed against a live account, and a guessed pattern that never matches
 * would leave a working tunnel reported as not-ready forever. Alive-is-ready
 * is the honest fallback the contract defines — and a connector that cannot
 * authenticate exits rather than idling, so the backoff and park states still
 * carry the failures that matter.
 */
export function tunnelProcessSpec(binary: string): SupervisedProcessSpec {
  return {
    command: binary,
    args: ["tunnel", "run", "--no-autoupdate"],
    secretEnv: { TUNNEL_TOKEN: TOKEN_SECRET },
  };
}

/**
 * Takes the publish down — by doing nothing.
 *
 * The host's ordering owns this sequence end to end (§ 5.3): it stopped the
 * supervised child and waited for it to be reaped BEFORE calling this, and it
 * drops the guard AFTER. And there is no vendor-side half to undo either:
 * the tunnel, its public hostname and its Access application are the
 * operator's Cloudflare resources — an unpublish that deleted them would be
 * a destructive act nobody asked for, and one a `view` of nothing could not
 * be trusted with.
 */
export async function unpublishTunnel(host: PluginHost): Promise<void> {
  host.log.debug(
    "cloudflare-tunnel: unpublish is a no-op; the host stopped the process and drops the guard after this",
  );
}

/**
 * Disconnects: deletes the token and nothing else.
 *
 * The host has already run the unpublish sequence by the time `leave` is
 * called, so the child is gone and the guard is down; the credential is the
 * one thing that survives an unpublish and the one thing a disconnect exists
 * to remove. The settings stay in the host's own state file for the route to
 * forget, as for every plugin.
 */
export async function leaveTunnel(host: PluginHost): Promise<void> {
  await host.secrets.delete(TOKEN_SECRET);
}
