import { isDocsUrl, type PluginHost, type RunOptions, type RunResult } from "@subshell-ai/plugin-api";
import { manifest } from "./manifest.js";

/**
 * The subset of `tailscale status --json` this plugin reads.
 *
 * Deliberately partial and entirely optional. The document is a vendor's, it
 * gains fields between releases, and `status` must never throw — so every
 * field is `?` and every reader below copes with its absence rather than
 * asserting a shape a future Tailscale might not produce.
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
     * The MagicDNS FQDN, which Tailscale prints WITH a trailing dot
     * (`mac-mini.tailnet-abc.ts.net.`). Every consumer here is building a URL,
     * so it is stripped once in {@link magicDnsName} rather than at each use.
     */
    DNSName?: string;
  };
  /** Every tailnet address of this machine, IPv4 and IPv6 interleaved. */
  TailscaleIPs?: string[];
  /**
   * The names Tailscale can issue a TLS certificate for.
   *
   * EMPTY is the case that decides everything about publishing: it means
   * HTTPS certificates (or MagicDNS) are not enabled for this tailnet, so
   * `tailscale serve --https=443` has no certificate to present and there is
   * no secure-context address to hand out. It is an admin-console setting,
   * not something this machine can turn on, which is why it produces a
   * refusal with a docs link rather than an attempt.
   */
  CertDomains?: string[];
  /** The tailnet this machine is currently a member of. */
  CurrentTailnet?: {
    /** The tailnet's display name, e.g. `example.com`. */
    Name?: string;
  };
  /** The tailnet's DNS suffix, e.g. `tailnet-abc.ts.net`. */
  MagicDNSSuffix?: string;
}

/** The binary name, env override and known install locations, from the manifest. */
const DETECT = manifest.detect;

/**
 * Resolves the `tailscale` binary through the host's own lookup ladder.
 *
 * Reads the manifest rather than repeating the three detection values, so the
 * data a host scans a machine with (without loading this file) and the data
 * this file runs against cannot drift apart.
 *
 * `knownPaths` entries are HOME-relative, or absolute when one starts with
 * `/`, and the manifest lists both kinds: `.local/bin/tailscale` beside
 * `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. The absolute entries
 * are what answer on a Mac, because a launchd service's PATH names neither
 * Homebrew directory and the login-shell rung depends on the user's profile.
 * `TAILSCALE_PATH` remains the answer for a machine whose Tailscale is somewhere
 * none of them say.
 */
export async function resolveBinary(host: PluginHost): Promise<string | null> {
  if (!DETECT) return null;
  return host.findBinary(DETECT.binaryName, DETECT.envOverride, DETECT.knownPaths);
}

/**
 * Runs the vendor CLI, telling it to behave as one.
 *
 * The Mac app's binary is the same executable as its GUI. Asked to do
 * something with a bare environment it tries to start the interface and dies
 * with `The Tailscale GUI failed to start: … (Tailscale.CLIError error 3.)`;
 * `TAILSCALE_BE_CLI=1` (tailscale.com/kb/1080/cli) is what makes it a CLI.
 *
 * Every run in this plugin goes through here rather than calling `host.run`
 * itself, because the requirement is a property of the BINARY and which binary
 * the ladder landed on is not known until runtime — the same argv reaches the
 * Homebrew formula, the app's `/usr/local/bin` wrapper and the bundle, and the
 * variable is inert for the first two and load-bearing for the third.
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
 * `status` is called on every page load and before every act, and its contract
 * says it never throws — so a body that will not parse has to become a state
 * with a hint, which it cannot do from inside a `JSON.parse` that exploded.
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
 * The dot is correct in DNS and wrong in a URL: `https://host.ts.net./` is a
 * different origin string from `https://host.ts.net/`, and the host stores
 * these as trusted origins verbatim. Falls back to the first cert domain,
 * which is the same name by construction and is present in exactly the case
 * that matters (a tailnet with HTTPS enabled).
 */
export function magicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName?.trim();
  if (dnsName) return dnsName.replace(/\.$/, "");
  const cert = status.CertDomains?.find((d) => typeof d === "string" && d.trim() !== "");
  return cert ? cert.trim().replace(/\.$/, "") : null;
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
 * Tailscale's errors are one useful line followed by usage text or a stack of
 * health warnings, and a hint is a sentence a person reads — so the rest is
 * dropped rather than pasted into the UI.
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
 * Matched on the vendor's own phrasings, because the exit code does not
 * distinguish them: `tailscale status` exits non-zero for a down daemon, a
 * permission refusal and a malformed flag alike.
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
 * Checked BEFORE {@link looksLikeDaemonDown}, which is a decision rather than
 * an ordering accident: Tailscale's access-denied messages routinely also say
 * "no server running?" in the same sentence, so a daemon-down check that ran
 * first would swallow every permission problem and send the operator to
 * restart a daemon that is already up. Nothing in the reverse direction
 * collides — a plain "failed to connect" names no operator and no denial.
 */
export function looksLikePermissionDenied(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("access denied") || t.includes("permission denied") || t.includes("operator");
}

/**
 * A display name for the OS user this server runs as, derived from the home
 * directory's last segment.
 *
 * A DISPLAY hint and not an identity check: nothing is authorized on the
 * strength of it. It exists so the copyable `sudo tailscale set --operator=…`
 * line names a plausible user instead of a literal `$USER` the reader has to
 * substitute, and a home directory that does not match the account name
 * yields a slightly wrong suggestion rather than a wrong decision.
 */
export function likelyUserName(homeDir: string): string {
  const segment = homeDir.split("/").filter(Boolean).pop();
  return segment && segment.trim() !== "" ? segment : "$USER";
}

/**
 * A login URL this plugin is willing to hand back, or nothing.
 *
 * `AuthURL` is the one value here that Tailscale does not choose: the local
 * daemon reports whatever its CONTROL SERVER sent, and `--login-server` makes
 * that an address the operator picked — a self-hosted Headscale, or something
 * standing in for one. It then travels to a page where it is offered as a link
 * to open and a value to copy, which is the whole reason the scheme matters.
 *
 * Absent is the honest answer for an unusable one. A `needs-login` row with no
 * link falls back to "join a tailnet", which is exactly the situation; a
 * plugin that passed the value along and let a later layer strip it would be
 * reporting something it had no reason to believe.
 * @param raw - `AuthURL` as the daemon reported it, or a URL scraped from `up`
 */
export function loginUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !isDocsUrl(trimmed)) return undefined;
  return trimmed;
}

/**
 * The control server Tailscale's own hosted service runs.
 *
 * The daemon's prefs carry this verbatim for a machine enrolled the ordinary
 * way, and `tailscale up --login-server <url>` REPLACES it. It is the constant
 * both plugins compare against: `status --json` has no control-server field at
 * all (measured 2026-09-16 on 1.102.4 — no `LoginServer` key), so
 * {@link readControlUrl} asks the one command that does answer.
 */
export const TAILSCALE_SERVICE_CONTROL_URL = "https://controlplane.tailscale.com";

/**
 * The control server the DAEMON says it serves, or `undefined` when it cannot say.
 *
 * `tailscale debug prefs` is unprivileged, prints the daemon's prefs as JSON,
 * and its `ControlURL` is the ownership answer the 2026-09-16 amendment to
 * § 8 needed: the phantom this exists for was a Headscale row reading `Joined`
 * on a machine whose daemon actually serves Tailscale's SaaS.
 *
 * `undefined` covers every way the daemon cannot answer — a non-zero exit (an
 * old CLI without the verb), an empty body, a body that will not parse, a
 * missing or empty field — so every caller fails open to whatever it did
 * before this read existed. NEVER throws: `status` runs on every page load.
 */
export async function readControlUrl(
  host: PluginHost,
  binary: string,
  opts: RunOptions = {},
): Promise<string | undefined> {
  const result = await runTailscale(host, binary, ["debug", "prefs"], opts);
  if (result.code !== 0 || result.stdout.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const url = (value as { ControlURL?: unknown }).ControlURL;
    if (typeof url !== "string") return undefined;
    return url.trim() === "" ? undefined : url.trim();
  } catch {
    return undefined;
  }
}

/**
 * A control URL in the one spelling equality can be checked in, or `null`.
 *
 * `new URL` canonicalizes host case and a default port, and the single
 * trailing slash is the difference between `https://hs.example.net` and the
 * same URL as typed with one — a difference in nothing a human means. An
 * empty, unparseable or non-http(s) value answers `null`, and `null` equals
 * nothing: a URL that cannot be canonicalized can never be DEMONSTRATED to be
 * the configured one, which is the safe direction for both plugins' ownership
 * comparisons.
 */
export function normalizeControlUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Whether a reported control URL is Tailscale's own service, in any spelling of it. */
export function isTailscaleServiceControlUrl(value: string): boolean {
  return normalizeControlUrl(value) === TAILSCALE_SERVICE_CONTROL_URL;
}

/**
 * The host (with its port when it has one) a control URL names, for a hint.
 *
 * A value that will not parse comes back as its own trimmed text: the hint
 * then quotes whatever the daemon reported, which is still the truth about
 * where this machine goes.
 */
export function controlServerHost(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}
