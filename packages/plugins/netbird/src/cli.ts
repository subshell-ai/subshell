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
 * **The spellings that matter are MEASURED (0.66.4, the operator's host,
 * 2026-09-16).** The IP arrives under `netbirdIp` — CIDR-suffixed, verbatim
 * `"100.71.129.37/16"` — the version under `daemonVersion` and `cliVersion`,
 * the name under `fqdn`, and there is NO top-level `hostname` at all. The
 * guesses the two specs named (`peerIP`, `ip`, `netbirdVersion`, `version`)
 * were written before any live daemon was available and stay as fallbacks;
 * § 10.4's other half — the peer-credential authorisation behind "no
 * `needs-privilege` state" — is still unmeasured and is handled in `status.ts`.
 * The honest answer to a document nothing matches remains `daemon-down`, a
 * state with a hint, never a crash.
 */
export interface NetbirdStatusJson {
  /** The daemon's link to the management service. Its `connected` gates join. */
  management?: {
    /** False or absent means this machine has not been enrolled yet. */
    connected?: boolean;
  };
  /** This peer's NetBird IP. Measured spelling is `netbirdIp`, CIDR-suffixed. */
  peerIP?: string;
  /** Alternate spelling of the peer IP. */
  ip?: string;
  /** The peer IP as the 0.66.4 daemon sends it: `"100.71.129.37/16"`. */
  netbirdIp?: string;
  /** This peer's fully-qualified name on the NetBird network, if DNS is set up. */
  fqdn?: string;
  /** This machine's peer name. Absent on 0.66.4 — `fqdn` carries the name. */
  hostname?: string;
  /** The running daemon's version — measured, and the one worth reporting. */
  daemonVersion?: string;
  /** The CLI that asked. Reported only when the daemon does not answer. */
  cliVersion?: string;
  /** Guessed spelling of the version, kept as a fallback. */
  netbirdVersion?: string;
  /** Alternate guessed spelling of the version. */
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
 * A CIDR prefix as the daemon spells it — a slash and digits, and nothing else.
 *
 * Narrow on purpose. `100.71.129.37/` and `100.71.129.37/x` are not a subnet
 * suffix someone meant literally; they are a value this reader cannot interpret,
 * and the honest answer for one is no address rather than a guess at a host.
 */
const CIDR_SUFFIX_RE = /\/\d+$/;

/**
 * This peer's NetBird IPv4 address, from whichever spelling the document uses.
 *
 * A trailing `/prefixlen` comes off first: **measured on 0.66.4**, the top-level
 * `netbirdIp` is `"100.71.129.37/16"`, and an address with a subnet suffix is not
 * a URL host. Rejecting it whole is what made the card show no IP under a hint
 * telling the operator to use the IP address.
 *
 * The candidates are then tried in the order the two specs named them (`peerIP`,
 * the plain `ip`, then `netbirdIp`) — a guess-order that survives as FALLBACK,
 * since the measured spelling is the last of the three. Only an IPv4 survives,
 * for the URL-safety reason Tailscale's reader gives; a document that carries
 * none yields `null` and the caller lists just the FQDN address.
 */
export function peerIpv4(status: NetbirdStatusJson): string | null {
  for (const candidate of [status.peerIP, status.ip, status.netbirdIp]) {
    const trimmed = candidate?.trim().replace(CIDR_SUFFIX_RE, "");
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
