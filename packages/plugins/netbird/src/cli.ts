import { isDocsUrl, type PluginHost, type RunOptions, type RunResult } from "@subshell-ai/plugin-api";
import { manifest } from "./manifest.js";

/**
 * The subset of `netbird status --json` this plugin reads.
 *
 * Deliberately partial and entirely optional. The document is a vendor's, it
 * gains fields between releases, and `status` must never throw — so every field
 * is `?` and every reader copes with its absence rather than asserting a shape a
 * future NetBird might not produce.
 *
 * **The field spellings are UNMEASURED (§ 10.4).** No live NetBird daemon was
 * available to pin them, so the IP is read from several candidate keys
 * (`peerIP`, `ip`, `netbirdIp`) and the version from both `netbirdVersion` and
 * the plain `version`. The master spec's vendor table names `netbirdIp` where
 * the phase-2/3 spec names `peerIP`; rather than pick one and be silently wrong
 * about the other, every spelling is tried and the honest answer to a document
 * none of them match is `daemon-down` — a state with a hint, never a crash.
 */
export interface NetbirdStatusJson {
  /** The daemon's link to the management service. Its `connected` gates join. */
  management?: {
    /** False or absent means this machine has not been enrolled yet. */
    connected?: boolean;
  };
  /** This peer's NetBird IP. Read from `peerIP`, `ip` or `netbirdIp`. */
  peerIP?: string;
  /** Alternate spelling of the peer IP. */
  ip?: string;
  /** Alternate spelling of the peer IP. */
  netbirdIp?: string;
  /** This peer's fully-qualified name on the NetBird network, if DNS is set up. */
  fqdn?: string;
  /** This machine's peer name. */
  hostname?: string;
  /** The running NetBird version. Read from `netbirdVersion` or `version`. */
  netbirdVersion?: string;
  /** Alternate spelling of the version. */
  version?: string;
}

/** The binary name, env override and known install locations, from the manifest. */
const DETECT = manifest.detect;

/**
 * Resolves the `netbird` binary through the host's own lookup ladder.
 *
 * Reads the manifest rather than repeating the three detection values, so the
 * data a host scans a machine with (without loading this file) and the data this
 * file runs against cannot drift apart.
 *
 * `knownPaths` entries are HOME-relative, or absolute when one starts with `/`;
 * the manifest lists both kinds. The absolute Homebrew paths are what answer on
 * a Mac, because a launchd service's PATH names neither Homebrew directory.
 * `NETBIRD_PATH` is the answer for a machine whose NetBird lives elsewhere.
 */
export async function resolveBinary(host: PluginHost): Promise<string | null> {
  if (!DETECT) return null;
  return host.findBinary(DETECT.binaryName, DETECT.envOverride, DETECT.knownPaths);
}

/**
 * Runs the vendor CLI.
 *
 * Unlike the Tailscale plugin, no marker environment is set: NetBird's binary
 * is a plain CLI on every install route, so there is nothing to tell it to be.
 *
 * @param host - the plugin host that runs the process
 * @param binary - the resolved binary path, from {@link resolveBinary}
 * @param args - argv after the binary; no shell, no quoting
 * @param opts - the run's deadline, stream callbacks and any extra env
 */
export function runNetbird(
  host: PluginHost,
  binary: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return host.run([binary, ...args], opts);
}

/**
 * Parses `netbird status --json`, answering null rather than throwing.
 *
 * `status` is called on every page load and before every act, and its contract
 * says it never throws — so a body that will not parse has to become a state
 * with a hint, which it cannot do from inside a `JSON.parse` that exploded.
 */
export function parseStatusJson(raw: string): NetbirdStatusJson | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as NetbirdStatusJson;
  } catch {
    return null;
  }
}

/** True when the management connection is up — the one signal that means joined. */
export function isManagementConnected(status: NetbirdStatusJson): boolean {
  return status.management?.connected === true;
}

/** IPv4 only: an IPv6 literal needs brackets in a URL and no browser needs it here. */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * This peer's NetBird IPv4 address, from whichever spelling the document uses.
 *
 * Tried in the order the two specs name them (`peerIP` first, then the plain
 * `ip`, then the master table's `netbirdIp`). Only an IPv4 survives, for the
 * URL-safety reason Tailscale's reader gives; a document that carries none —
 * or an unparseable future shape — yields `null` and the caller lists just the
 * FQDN address.
 */
export function peerIpv4(status: NetbirdStatusJson): string | null {
  for (const candidate of [status.peerIP, status.ip, status.netbirdIp]) {
    const trimmed = candidate?.trim();
    if (trimmed && IPV4_RE.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * This peer's FQDN with a trailing dot stripped, or null.
 *
 * A trailing dot is correct in DNS and a different origin string in a URL, so it
 * is dropped once here rather than at each use.
 */
export function peerFqdn(status: NetbirdStatusJson): string | null {
  const fqdn = status.fqdn?.trim();
  return fqdn ? fqdn.replace(/\.$/, "") : null;
}

/**
 * The first non-blank line of some command output, for a hint.
 *
 * NetBird's errors are one useful line followed by usage text, and a hint is a
 * sentence a person reads — so the rest is dropped rather than pasted into the
 * UI.
 */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * A login URL this plugin is willing to hand back, or nothing.
 *
 * The device-flow URL NetBird prints is read off a vendor CLI that read it off
 * its own SSO provider, so its scheme is not guaranteed. It reaches a page as a
 * link to open and a value to copy, which is the whole reason it is checked: an
 * `href` is not inert. Absent is the honest answer for an unusable one — a
 * `needs-login` row with no link falls back to "join the network", which is
 * exactly the situation.
 * @param raw - a URL scraped from the interactive `up` output
 */
export function loginUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !isDocsUrl(trimmed)) return undefined;
  return trimmed;
}
