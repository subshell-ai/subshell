import type { JoinInput, JoinOutcome, PluginHost } from "@subshell-ai/plugin-api";
import { isTunnelTokenShape, TOKEN_SECRET } from "./cli.js";

/**
 * Connects this machine to its tunnel by storing the connector token.
 *
 * **Nothing spawns.** Cloudflare has no `up`: the token IS the connector's
 * identity, which is exactly why it is the one credential in this feature
 * that goes to the write-only secret store rather than transit through argv
 * once (spec 2026-09-15 § 4.4). `interactiveLogin` is false in the manifest,
 * so the no-credential path exists only to say so.
 *
 * The shape check happens before the store, because a pasted API token or
 * certificate would otherwise sit here looking configured until the first
 * supervised `cloudflared tunnel run` failed on the vendor's own words —
 * minutes later, in a journal, instead of in this sentence.
 *
 * Throws rather than returning a refusal: `JoinOutcome` has no shape for
 * "this did not happen", and the host maps a throw to a 400 the operator
 * reads at the field.
 */
export async function joinTunnel(host: PluginHost, input: JoinInput): Promise<JoinOutcome> {
  const credential = input.credential?.trim();
  if (!credential) {
    throw new Error(
      "Cloudflare Tunnel joins with a tunnel token — there is no interactive sign-in. Copy it from Zero Trust → Networks → Tunnels → the tunnel's connector.",
    );
  }
  if (!isTunnelTokenShape(credential)) {
    throw new Error(
      "That does not look like a Cloudflare tunnel token. Copy it from Zero Trust → Networks → Tunnels → the tunnel's connector.",
    );
  }
  await host.secrets.set(TOKEN_SECRET, credential);
  return { state: "joined" };
}
