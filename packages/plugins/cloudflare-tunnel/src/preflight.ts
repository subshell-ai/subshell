import type { TunnelSettings } from "./cli.js";

/**
 * The publish-time Access pre-flight (spec 2026-09-15 § 6).
 *
 * **This is the one outbound request the plugin makes**, and it is the whole
 * gate: the plugin refuses to publish until the vendor itself confirms an
 * Access application covers the hostname. Access evaluates at Cloudflare's
 * edge, before the origin, so this passes on a hostname Access guards even
 * while the tunnel is down — and fails on a bare public hostname, which is
 * the exact state this plugin exists to refuse.
 *
 * **§ 10.5 is UNMEASURED**: the exact status and header names a pre-flight
 * sees were never observed against a live Access team (no test hostname was
 * available). The reader is therefore loose in the direction of PASSING only
 * on positive evidence — the `Location` header or any `cf-access-*` header,
 * "if present" — and **every other outcome, including a failed check, is a
 * refusal**. A pass on a 200 from a bare origin, or a publish after a network
 * error, would be the hole this whole function exists to close; silence in
 * the face of a missing header is not a hole, it is an operator re-pressing
 * Publish after fixing the dashboard.
 */

/** How long the pre-flight waits for Cloudflare's edge before failing closed. */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/** What the pre-flight concluded. */
export type PreflightAnswer = { covered: true } | { covered: false; reason: string };

/**
 * Asks `https://<hostname>/` whether Access stands in front of it.
 *
 * `redirect: "manual"` is load-bearing: Access answers a guarded hostname
 * with a redirect to the team's login page, and FOLLOWING it would land on
 * the login page itself — which looks like a successful response from a
 * client that never asked who the response was for. The fetches are done with
 * the global `fetch` at call time; no plugin code runs in a request path this
 * could hold open beyond the deadline.
 */
export async function accessCovers(settings: TunnelSettings): Promise<PreflightAnswer> {
  const notCovered = (): PreflightAnswer => ({
    covered: false,
    reason: `Cloudflare Access does not cover ${settings.hostname} yet. Create an Access application for it, then publish.`,
  });
  try {
    const response = await fetch(`https://${settings.hostname}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (location?.startsWith(`https://${settings.teamDomain}/`)) return { covered: true };
    for (const [name] of response.headers) {
      if (name.toLowerCase().startsWith("cf-access-")) return { covered: true };
    }
    return notCovered();
  } catch (err) {
    // The vendor's own words — "the check errored" is never a pass. The
    // hostname may not resolve at all (the DNS record is a dashboard step
    // this plugin does not perform), and that is exactly the unguarded state.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      covered: false,
      reason: `Cloudflare Access could not be confirmed for ${settings.hostname}: ${reason}. Nothing was published.`,
    };
  }
}
