import type { NetworkAddress, NetworkContext, NetworkHint, NetworkStatus, PluginHost } from "@subshell-ai/plugin-api";
import {
  firstLine,
  likelyUserName,
  loginUrl,
  looksLikeDaemonDown,
  looksLikePermissionDenied,
  magicDnsName,
  parseStatusJson,
  resolveBinary,
  runTailscale,
  type TailscaleStatusJson,
  tailnetIpv4s,
} from "./cli.js";
import {
  certificateTransparencyHint,
  daemonDownHints,
  httpsUnavailableHint,
  needsPrivilegeHints,
  notInstalledHints,
} from "./hints.js";

/** A status read is one CLI call, so it is bounded well below the host's 30s default. */
const STATUS_TIMEOUT_MS = 15_000;

/**
 * Everything one status read learned, not just what the contract reports.
 *
 * `publish` needs facts `NetworkStatus` has no field for — whether this
 * tailnet issues certificates, and what this machine's MagicDNS name is — and
 * re-running the CLI to get them would be a second read that can disagree with
 * the first. So the read is done once and both halves are returned.
 */
export interface TailscaleRead {
  /** What {@link NetworkPlugin.status} reports verbatim. */
  status: NetworkStatus;
  /** The parsed `status --json`, or null when there was nothing to parse. */
  json: TailscaleStatusJson | null;
  /** The resolved CLI, or null when Tailscale is not installed. */
  binary: string | null;
}

/**
 * Reads where this host stands with Tailscale, in one pass.
 *
 * NEVER throws, which is the whole shape of it: an absent binary, a dead
 * daemon, a refused socket and a body that will not parse are all states with
 * a hint, because this runs on every page load and a rejection there is a page
 * that says nothing at all.
 */
export async function readNetwork(host: PluginHost, ctx: NetworkContext): Promise<TailscaleRead> {
  const binary = await resolveBinary(host);
  if (!binary) {
    return {
      binary: null,
      json: null,
      status: { state: "not-installed", addresses: [], hints: notInstalledHints(host.platform) },
    };
  }

  // `--peers=false` is not an optimization. `status --json` embeds the whole
  // peer map, which on a real tailnet runs to tens of kilobytes, and the host
  // caps captured output at 64 KiB and appends a truncation marker past it. A
  // truncated document does not parse, so a perfectly healthy daemon reported
  // `daemon-down` saying Tailscale "did not report a status this server could
  // read" — and the bigger the tailnet, the more certain it was. Every field
  // this plugin reads is top-level: `BackendState`, `AuthURL`, `Self`,
  // `TailscaleIPs`, `CertDomains`, `CurrentTailnet`.
  const result = await runTailscale(host, binary, ["status", "--json", "--peers=false"], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  // **Only a FAILED run is diagnosed, and only from stderr.** Both matchers
  // below are substring tests over loose vendor prose — `looksLikePermissionDenied`
  // matches the bare word "operator" — and a SUCCESSFUL `status --json` prints
  // the whole tailnet document on stdout: ACL tags (`tag:operator` is a common
  // one), peer names, user display names, health strings. Matching against that
  // turned a perfectly healthy machine into `needs-privilege` with no
  // addresses, publishing blocked, and a copyable `sudo tailscale set
  // --operator=…` that changes nothing because the grant already exists. The
  // permission and socket texts only ever appear on a failure, so failure is
  // the only place worth looking.
  const failed = result.code !== 0;
  const diagnosis = failed ? result.stderr : "";

  // Permission first. See `looksLikePermissionDenied`: Tailscale's
  // access-denied text often also mentions a server that is not running, so
  // the more specific test has to win or every operator problem is reported as
  // a dead daemon.
  if (looksLikePermissionDenied(diagnosis)) {
    return {
      binary,
      json: null,
      status: { state: "needs-privilege", addresses: [], hints: needsPrivilegeHints(likelyUserName(host.homeDir)) },
    };
  }

  const json = result.stdout.trim() === "" ? null : parseStatusJson(result.stdout);

  // A failed run, an empty body, or a body that will not parse all land here.
  // The last of those is the one worth naming: a future Tailscale that changes
  // its output, or a wrapper that prints a banner first, must not crash a page
  // — it becomes `daemon-down` carrying whatever the CLI actually said, which
  // is the only thing that can explain it.
  if (result.code !== 0 || json === null) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    const hints = looksLikeDaemonDown(diagnosis)
      ? daemonDownHints(host.platform, detail)
      : daemonDownHints(host.platform, detail || "Tailscale did not report a status this server could read.");
    return { binary, json, status: { state: "daemon-down", addresses: [], hints } };
  }

  const identity = await readIdentity(host, binary, json);

  if (json.BackendState !== "Running") {
    const authUrl = loginUrl(json.AuthURL);
    return {
      binary,
      json,
      status: {
        state: "needs-login",
        addresses: [],
        ...(authUrl ? { loginUrl: authUrl } : {}),
        identity,
        hints: needsLoginHints(json.BackendState, authUrl),
      },
    };
  }

  const addresses = tailnetAddresses(json, ctx.port);
  const hints: NetworkHint[] = [];
  const dnsName = magicDnsName(json);
  if ((json.CertDomains ?? []).length === 0) hints.push(httpsUnavailableHint());
  // Said where someone deciding whether to publish is looking, and only when
  // publishing would actually issue a certificate.
  else if (dnsName) hints.push(certificateTransparencyHint(dnsName));

  const published = await isServingThisPort(host, binary, ctx.port);
  return {
    binary,
    json,
    status: { state: published ? "published" : "joined", addresses, identity, hints },
  };
}

/**
 * What this machine is called on this tailnet, for the UI's identity line.
 *
 * The version comes from the host's own bounded probe rather than a second
 * `host.run`, and only its first line survives: `tailscale version` prints the
 * semver and then three lines of commit hashes, and an identity line is a
 * label rather than a report.
 */
async function readIdentity(
  host: PluginHost,
  binary: string,
  json: TailscaleStatusJson,
): Promise<NetworkStatus["identity"]> {
  // `version`, not `--version`: the subcommand is the documented form and the
  // one every release understands.
  const raw = await host.probeVersion(binary, ["version"]);
  const version = raw ? firstLine(raw) : "";
  const network = json.CurrentTailnet?.Name?.trim();
  const hostname = json.Self?.HostName?.trim();
  return {
    ...(network ? { network } : {}),
    ...(hostname ? { hostname } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * The addresses this server can be reached at over the tailnet.
 *
 * Two kinds, and the order is load-bearing: the host promotes `addresses[0]`
 * when asked to set the base URL, so the HTTPS name goes first whenever there
 * is one.
 *
 * The IP addresses are listed even when the HTTPS name exists, and that is not
 * redundancy. `http://<tailnet-ip>:<port>` works with no `serve` at all and
 * with no certificate — it is what a machine reaches this server on today —
 * whereas the MagicDNS name needs both. Its `secureContext: false` says what
 * the browser will refuse there (passkeys, `Secure` cookies), not that the
 * traffic is unencrypted: WireGuard carries it either way.
 */
function tailnetAddresses(json: TailscaleStatusJson, port: number): NetworkAddress[] {
  const addresses: NetworkAddress[] = [];
  const dnsName = magicDnsName(json);
  if ((json.CertDomains ?? []).length > 0 && dnsName) {
    addresses.push({ url: `https://${dnsName}`, scheme: "https", label: "MagicDNS", secureContext: true });
  }
  for (const ip of tailnetIpv4s(json)) {
    addresses.push({ url: `http://${ip}:${port}`, scheme: "http", label: "Tailscale IP", secureContext: false });
  }
  return addresses;
}

/**
 * Whether `tailscale serve` is already proxying this server's port.
 *
 * The serve config's JSON shape has changed across Tailscale releases (the
 * handler map has been keyed by host:port and by port alone, and the proxy
 * target has moved), so this does NOT walk it. It searches the serialized
 * document for the proxy target string, which every version of that shape
 * contains verbatim when a handler points here. The cost is a theoretical
 * false positive from a target appearing somewhere else in the document; the
 * benefit is that a version bump cannot silently make a published server
 * report itself as merely joined.
 */
async function isServingThisPort(host: PluginHost, binary: string, port: number): Promise<boolean> {
  const result = await runTailscale(host, binary, ["serve", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  if (result.code !== 0) return false;
  const parsed = parseStatusJson(result.stdout);
  // Re-serialize when it parses, so key order and whitespace cannot matter;
  // fall back to the raw text when it does not, because a shape this cannot
  // parse may still name the port.
  const haystack = parsed ? JSON.stringify(parsed) : result.stdout;
  // Anchored on what must follow the port, or `3080` matches a serve target on
  // `30800`. A port is the last component of these targets, so the next
  // character is a JSON delimiter or a path separator — never another digit.
  const targets = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return targets.some((target) => {
    const at = haystack.indexOf(target);
    if (at === -1) return false;
    const next = haystack.charAt(at + target.length);
    return next === "" || !/[0-9]/.test(next);
  });
}

/**
 * What to do next when this machine is not on a tailnet.
 *
 * `Stopped` gets its own sentence because it is the one case where everything
 * is already set up: the machine is enrolled and switched off, so telling its
 * operator to sign in would send them through a login they have done.
 */
function needsLoginHints(backendState: string | undefined, authUrl: string | undefined): NetworkHint[] {
  if (backendState === "Stopped") {
    return [
      { text: "Tailscale is installed and switched off. Turn it back on, then re-check.", command: "tailscale up" },
    ];
  }
  if (authUrl) {
    return [{ text: "Finish signing in to Tailscale to put this machine on your tailnet.", docsUrl: authUrl }];
  }
  return [{ text: "This machine is not on a tailnet yet. Join one to reach this server from your other devices." }];
}
