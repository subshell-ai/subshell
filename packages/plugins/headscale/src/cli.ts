import { isDocsUrl, type PluginHost, type RunOptions, type RunResult } from "@subshell-ai/plugin-api";
import { manifest } from "./manifest.js";

/**
 * Shared helpers for driving the `tailscale` binary at a Headscale control
 * server.
 *
 * **Copied from `@subshell-ai/plugin-tailscale`'s `src/cli.ts`** (spec
 * 2026-09-16 § 4). The inline route that section names first — tsdown
 * `noExternal` on the tailscale package — was tried and does not carry this
 * code: the package exports exactly its factory and manifest (TS2614 for any
 * helper; `@subshell-ai/plugin-tailscale/cli` is refused by its exports map),
 * and pulling its module graph in would parse tailscale's own package.json at
 * load, which is precisely what § 4 forbids here. So the source is copied,
 * and `src/__tests__/headscale.test.ts` contains the containment test that
 * pins the shared argv constants — the `tmux-<uid>` precedent — so a silent
 * divergence between the two plugins is a red test rather than a surprise.
 *
 * Two edits from the original, both mandated by § 4: `resolveBinary` reads
 * THIS package's manifest (same values by decision — it is the same binary —
 * but this plugin's bytes are its own), and the comments say Headscale where
 * the original's subject was the tailnet's own admin console.
 */

/**
 * The subset of `tailscale status --json` this plugin reads.
 *
 * Deliberately partial and entirely optional, and the name kept from the
 * origin: it is the tailscale BINARY's document even when the control server
 * is a Headscale. The document is a vendor's, it gains fields between
 * releases, and `status` must never throw — so every field is `?` and every
 * reader below copes with its absence.
 */
export interface TailscaleStatusJson {
  /**
   * The daemon's own word for where this machine stands: `NeedsLogin`,
   * `Running`, `Stopped`, `Starting` or `NoState`. Anything but `Running`
   * means this host is not on a tailnet it can serve on.
   */
  BackendState?: string;
  /** Where a human finishes an interactive login. Empty string when there is none. */
  AuthURL?: string;
  /** This machine's own node entry. */
  Self?: {
    /** Short machine name on the tailnet, e.g. `mac-mini`. */
    HostName?: string;
    /**
     * The MagicDNS FQDN, printed WITH a trailing dot
     * (`workshop.example.net.`). Every consumer here builds a URL, so it is
     * stripped once in {@link tailnetName} rather than at each use.
     */
    DNSName?: string;
  };
  /** Every tailnet address of this machine, IPv4 and IPv6 interleaved. */
  TailscaleIPs?: string[];
  /**
   * The names the control server can issue TLS certificates for.
   *
   * **Treated as ALWAYS EMPTY by this plugin** (spec 2026-09-16 § 4): a
   * Headscale tailnet issues no HTTPS certificates (headscale#2527), so
   * whatever the daemon reports here cannot be relied on, and the whole
   * publish model downstream — http addresses, `secureContext: false`, no
   * certificate disclosure — follows from the empty case alone.
   */
  CertDomains?: string[];
  /** The tailnet this machine is currently a member of. */
  CurrentTailnet?: {
    /** The tailnet's display name, e.g. `example.net`. */
    Name?: string;
  };
  /** The tailnet's DNS suffix, e.g. `example.net`. */
  MagicDNSSuffix?: string;
}

/** The binary name, env override and known install locations, from THIS manifest. */
const DETECT = manifest.detect;

/**
 * Resolves the `tailscale` binary through the host's own lookup ladder.
 *
 * Reads this package's manifest rather than repeating the three detection
 * values, so the data a host scans a machine with (without loading this file)
 * and the data this file runs against cannot drift apart. § 4's detection
 * decision — same `binaryName`/`envOverride`/`knownPaths` as the tailscale
 * plugin — is written into package.json, not shared by importing it.
 */
export async function resolveBinary(host: PluginHost): Promise<string | null> {
  if (!DETECT) return null;
  return host.findBinary(DETECT.binaryName, DETECT.envOverride, DETECT.knownPaths);
}

/**
 * Runs the vendor CLI, telling it to behave as one.
 *
 * Copied whole from `@subshell-ai/plugin-tailscale`'s `src/cli.ts`: the
 * requirement is a property of the BINARY, and this plugin drives the same
 * one. The Mac app's binary is the same executable as its GUI; asked to do
 * something with a bare environment it tries to start the interface and dies
 * with `The Tailscale GUI failed to start: … (Tailscale.CLIError error 3.)`;
 * `TAILSCALE_BE_CLI=1` (tailscale.com/kb/1080/cli) is what makes it a CLI.
 *
 * Every run in this plugin goes through here rather than calling `host.run`
 * itself, so no verb can be added later that forgets it.
 *
 * @param host - the plugin host that runs the process
 * @param binary - the resolved binary path, from {@link resolveBinary}
 * @param args - argv after the binary; no shell, no quoting
 * @param opts - the run's deadline, stream callbacks and any extra env
 */
export function runTailscale(
  host: PluginHost,
  binary: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return host.run([binary, ...args], { ...opts, env: { ...opts.env, TAILSCALE_BE_CLI: "1" } });
}

/**
 * Parses `tailscale status --json`, answering null rather than throwing.
 *
 * Copied from `@subshell-ai/plugin-tailscale`. `status` is called on every
 * page load and before every act, and its contract says it never throws — so
 * a body that will not parse has to become a state with a hint, which it
 * cannot do from inside a `JSON.parse` that exploded.
 */
export function parseStatusJson(raw: string): TailscaleStatusJson | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as TailscaleStatusJson;
  } catch {
    return null;
  }
}

/**
 * This machine's MagicDNS name with the trailing dot stripped, or null.
 *
 * The origin's `magicDnsName` falls back to the first cert domain — a
 * Tailscale-tailnet convenience that would be a LIE here: this plugin treats
 * `CertDomains` as always empty, so the fallback is dropped and only
 * `Self.DNSName` answers. The dot is correct in DNS and wrong in a URL:
 * `http://host.example.net./` is a different origin string from
 * `http://host.example.net/`, and the host stores these as trusted origins
 * verbatim.
 */
export function tailnetName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName?.trim();
  return dnsName ? dnsName.replace(/\.$/, "") : null;
}

/** IPv4 only: an IPv6 literal needs brackets in a URL and no browser needs it here. */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** This machine's tailnet IPv4 addresses, in the order the daemon reported them. */
export function tailnetIpv4s(status: TailscaleStatusJson): string[] {
  return (status.TailscaleIPs ?? []).filter((ip) => typeof ip === "string" && IPV4_RE.test(ip));
}

/**
 * The first non-blank line of some command output, for a hint.
 *
 * Copied from `@subshell-ai/plugin-tailscale`. The CLI's errors are one useful
 * line followed by usage text, and a hint is a sentence a person reads.
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
 * True when this output is the daemon being absent rather than anything else.
 *
 * Copied from `@subshell-ai/plugin-tailscale`; the phrasings are the shared
 * binary's, so they answer here unchanged. Matched on the vendor's own words,
 * because the exit code does not distinguish them.
 */
export function looksLikeDaemonDown(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("failed to connect") ||
    t.includes("not running") ||
    t.includes("socket") ||
    t.includes("connection refused")
  );
}

/**
 * True when this output is the OS refusing THIS user access to the daemon.
 *
 * Copied from `@subshell-ai/plugin-tailscale`, including the ordering note:
 * checked BEFORE {@link looksLikeDaemonDown}, because the CLI's access-denied
 * messages routinely also say "no server running?" in the same sentence, and
 * § 4 maps `needs-privilege` "exactly as tailscale does (the same 'Access
 * denied' strings)".
 */
export function looksLikePermissionDenied(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("access denied") || t.includes("permission denied") || t.includes("operator");
}

/**
 * A display name for the OS user this server runs as, from the home
 * directory's last segment.
 *
 * Copied from `@subshell-ai/plugin-tailscale`. A DISPLAY hint and not an
 * identity check: it exists so the copyable `sudo tailscale set --operator=…`
 * line names a plausible user instead of a literal `$USER`.
 */
export function likelyUserName(homeDir: string): string {
  const segment = homeDir.split("/").filter(Boolean).pop();
  return segment && segment.trim() !== "" ? segment : "$USER";
}

/**
 * A login URL this plugin is willing to hand back, or nothing.
 *
 * Copied from `@subshell-ai/plugin-tailscale`, and MORE load-bearing here:
 * with `--login-server`, the `AuthURL` the daemon reports is generated by the
 * operator's own Headscale every single time, not by a vendor that at least
 * has an interest in the value being a sign-in page. It travels to a page
 * where it is offered as a link to open, so `http(s)`-only is the rule.
 * @param raw - `AuthURL` as the daemon reported it, or a URL scraped from `up`
 */
export function loginUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !isDocsUrl(trimmed)) return undefined;
  return trimmed;
}
