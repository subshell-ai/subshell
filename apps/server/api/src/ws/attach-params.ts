/**
 * Everything a client declares on the attach URL, parsed once.
 *
 * A viewer's inputs to the shared-grid decision arrive over three channels —
 * this URL, the frame the client sends from `onopen`, and later frames — and
 * a run of live-only bugs all had the same shape: one channel not carrying
 * one input.
 *
 * - The local browser path read `hidden` from the URL; the remote path and
 *   the mobile client did not, so a phone attached to a node subshell while
 *   backgrounded, or any mobile reconnect made while pocketed, counted as a
 *   visible viewer for its whole life and held every laptop's pane at phone
 *   size.
 * - `hidden` had to move to the URL in the first place because the on-open
 *   frame races the handler's own awaits and is DROPPED when it wins, and
 *   nothing re-sends it until the tab is shown.
 * - The device label reached the remote path only because someone remembered
 *   to thread it through a positional parameter.
 *
 * Each was found by watching real clients rather than by a failing test,
 * because nothing in the types said an input had gone missing. Parsing the
 * whole set into ONE struct is what makes the next omission a type error:
 * both attach paths take an {@link AttachParams}, so a new field is either
 * carried or the compiler objects.
 */

import { normalizeDeviceLabel } from "@internal/subshell-protocol";

/** A terminal grid a client says it can display. */
export interface ClientGrid {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

/** What the connect URL says about the viewer behind it. */
export interface AttachParams {
  /**
   * The grid this client can display, or null when it said nothing (an older
   * client, a hand-built socket). The attach then skips its pre-capture
   * resize and behaves the way every client did before geometry existed.
   */
  size: ClientGrid | null;
  /** Human name for the device, shown in every other viewer's Devices list. */
  deviceLabel: string;
  /** True when the client declared itself not being rendered. */
  hidden: boolean;
  /** The client's self-reported bundle id, for the attach log line. */
  build: string;
}

/** Longest client build id the attach line will print (an asset hash is ~8). */
const MAX_BUILD_ID_LEN = 24;

/** Used when a client names no device. */
export const UNNAMED_DEVICE = "Unnamed device";

/**
 * Reads every attach input off the URL in one pass.
 *
 * @param url - The attach URL
 * @returns What this client declared about itself
 */
export function parseAttachParams(url: URL): AttachParams {
  return {
    size: parseInitialSize(url),
    deviceLabel: parseDeviceLabel(url),
    hidden: parseHidden(url),
    build: parseClientBuild(url),
  };
}

/**
 * The client geometry a browser passed on the WS URL (`&cols=&rows=`), or
 * null when absent/malformed (older client, manual connect) — the attach then
 * skips the pre-capture resize and behaves the old way.
 *
 * @param url - The attach URL
 * @returns The declared grid, or null
 */
export function parseInitialSize(url: URL): ClientGrid | null {
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));
  if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) return { cols, rows };
  return null;
}

/**
 * The device label from the connect URL, normalized and bounded.
 *
 * Chosen on the client and rendered in other viewers' browsers — which for a
 * shared subshell can mean another user — so it is re-normalized here rather
 * than trusted: the client's own sanitizing protects nothing against a
 * hand-built socket URL.
 *
 * @param url - The attach URL
 * @returns The label, or a neutral placeholder when absent/unusable
 */
export function parseDeviceLabel(url: URL): string {
  return normalizeDeviceLabel(url.searchParams.get("device") ?? "") || UNNAMED_DEVICE;
}

/**
 * Whether this viewer says it is NOT being rendered (`&hidden=1`).
 *
 * A hidden viewer takes no part in the shared-grid decision. It rides the URL
 * rather than waiting for the client's first frame because a frame sent from
 * `onopen` races the handler's own awaits and is dropped when it wins — and
 * unlike capacity, `visibility` is sent once and then only on change, so a
 * lost one is lost for the socket's whole life.
 *
 * Absent or unrecognized means visible: the pre-existing clients that send no
 * such param are exactly the ones with no way to be hidden.
 *
 * @param url - The attach URL
 * @returns True when the client declared itself hidden
 */
export function parseHidden(url: URL): boolean {
  const raw = url.searchParams.get("hidden");
  return raw === "1" || raw === "true";
}

/**
 * The client's self-reported bundle id (`&build=`) for the attach log line —
 * see the call site for why it exists. Untrusted display data: it is logged,
 * never used for a decision, so it is clamped to {@link MAX_BUILD_ID_LEN} and
 * reduced to a safe alphabet rather than validated against a list of known
 * builds. `MISSING` covers both "no param" and "nothing usable in it", which
 * are the same fact — a client too old to report.
 *
 * @param url - The attach URL
 * @returns The id, or `"MISSING"`
 */
export function parseClientBuild(url: URL): string {
  const raw = (url.searchParams.get("build") ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
  return raw ? raw.slice(0, MAX_BUILD_ID_LEN) : "MISSING";
}

/**
 * Rebuilds the attach URL from the upgrade request's parsed query — the
 * handler consumes it (token auth, and the `cols`/`rows` the pre-capture
 * resize needs). Passing the WHOLE query through is load-bearing: an earlier
 * version re-picked only subshell+token here, silently dropping the geometry
 * and regressing every attach to the stale-width replay (2026-09-01).
 * `URLSearchParams` re-encodes Elysia's already-decoded values exactly once.
 *
 * @param query - The upgrade request's parsed query params
 * @returns The reconstructed attach URL
 */
export function attachUrlFromQuery(query: Record<string, string>): URL {
  return new URL(`/ws?${new URLSearchParams(query).toString()}`, "http://localhost");
}
