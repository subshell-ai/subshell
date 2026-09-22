/**
 * Do this app's control-plane address and this machine's NODE address agree?
 *
 * They are two independent values. `planeUrl` (this app's setting) is what the
 * plane window opens; `serverUrl` in the node's `config.json` is what the
 * daemon dials. The Rust `plane_url_from` ladder falls back to the second only
 * when the first is unset, so once someone has opened a plane the two can
 * drift — and every surface shows exactly one of them, which is why a drift
 * used to be invisible: the app would show you a control plane while this
 * machine's subshells reported to a different one.
 *
 * Both halves of the fix exist. `node_configure` writes both at once, and this
 * is what notices the pairs that predate it, or that a CLI `subshell enroll`
 * created behind the app's back.
 */

/** A control-plane address mismatch worth telling the user about. */
export interface PlaneDivergence {
  /** What this app opens (its stored preference). */
  planeUrl: string;
  /** What this machine's node dials (`config.json`). */
  nodeServerUrl: string;
  /** Two sentences: the conflict first, then what it costs. */
  message: string;
}

/**
 * Compare two addresses the way the things that use them do: scheme, host
 * (case-insensitively, as DNS is) and port matter; a trailing slash does not.
 * Returns null for anything unparseable, so a bad value is never reported as
 * the node's fault.
 */
function canonical(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * The divergence between the app's plane address and the node's, or null.
 *
 * Null when they agree, when either is absent, or when either is unusable.
 * Only ONE being known is an ordinary state — a client that is not a node has
 * no `serverUrl`, and a machine enrolled from the CLI has no stored `planeUrl`
 * until it opens one — so silence there is correct, not a missed case.
 *
 * @param planeUrl - `settings.planeUrl` from `node_settings`
 * @param nodeServerUrl - `probe.status.serverUrl`, the enrolled node's own
 */
export function planeCoherence(
  planeUrl: string | null | undefined,
  nodeServerUrl: string | null | undefined,
): PlaneDivergence | null {
  if (!planeUrl || !nodeServerUrl) return null;
  const left = canonical(planeUrl);
  const right = canonical(nodeServerUrl);
  if (left === null || right === null || left === right) return null;
  return {
    planeUrl,
    nodeServerUrl,
    // Leads with the CONFLICT (review M2, 2026-09-22): "This app opens <url>,
    // but…" was the sentence shape the labeled rows made redundant, since the
    // reader is already looking at both addresses and the news is the
    // disagreement itself. And the second sentence names the target EXPLICITLY
    // (delta review I-2, 2026-09-22): with the node's address named FIRST,
    // "the second one" grammatically pointed at the plane's address — the
    // exact opposite of the truth. "There" reads to the nearest name, which
    // is the node's.
    message:
      `This machine's node reports to ${nodeServerUrl}, not ${planeUrl}. ` +
      "Subshells started here will appear there.",
  };
}
