import type { NetworkAddress, NetworkContext, NetworkHint, NetworkStatus, PluginHost } from "@subshell-ai/plugin-api";
import {
  controlServerHost,
  firstLine,
  isTailscaleServiceControlUrl,
  likelyUserName,
  loginUrl,
  looksLikeDaemonDown,
  looksLikePermissionDenied,
  normalizeControlUrl,
  parseStatusJson,
  readControlUrl,
  resolveBinary,
  runTailscale,
  type TailscaleStatusJson,
  tailnetIpv4s,
  tailnetName,
} from "./cli.js";
import {
  adminHint,
  daemonDownHints,
  foreignControlServerHints,
  httpOnlyHint,
  needsPrivilegeHints,
  notInstalledHints,
  TAILSCALE_SERVICE_LABEL,
} from "./hints.js";

/** A status read is one CLI call, so it is bounded well below the host's 30s default. */
const STATUS_TIMEOUT_MS = 15_000;

/** The ownership read is a local socket round trip answering one field; shorter still. */
const PREFS_TIMEOUT_MS = 5_000;

/**
 * Everything one status read learned, not just what the contract reports.
 *
 * Copied in shape from `@subshell-ai/plugin-tailscale`'s `src/status.ts`:
 * `publish` needs the parsed document and the resolved binary, and re-running
 * the CLI for them would be a second read that can disagree with the first.
 */
export interface HeadscaleRead {
  /** What {@link NetworkPlugin.status} reports verbatim. */
  status: NetworkStatus;
  /** The parsed `status --json`, or null when there was nothing to parse. */
  json: TailscaleStatusJson | null;
  /** The resolved CLI, or null when the tailscale client is not installed. */
  binary: string | null;
}

/**
 * Reads where this host stands with its Headscale tailnet, in one pass.
 *
 * Structurally the tailscale plugin's read (§ 4: "status: as tailscale"),
 * with the three differences that section names, each commented at its site:
 *
 * 1. `CertDomains` is treated as always empty — this file never reads it.
 * 2. `published` is still decided by `tailscale serve status` — the local
 *    daemon's own config, which the read can trust even while § 10.3 (does
 *    serve work against a given Headscale at all) is UNMEASURED.
 * 3. A `Running` daemon with no `CurrentTailnet.Name` reports joined with the
 *    hostname only; the name is not guessed from `MagicDNSSuffix`.
 *
 * Plus the read BOTH plugins gained on 2026-09-16 (the amendment to § 8's
 * non-policing, not a fourth difference): a `Running` daemon must also name
 * this plugin's control server in its own prefs before this row may claim
 * `joined` — see {@link ownsDaemon}. The tailscale plugin asks the same
 * `debug prefs` call and inverts the answer.
 *
 * NEVER throws, which is the whole shape of it: an absent binary, a dead
 * daemon, a refused socket and a body that will not parse are all states with
 * a hint, because this runs on every page load.
 */
export async function readNetwork(host: PluginHost, ctx: NetworkContext): Promise<HeadscaleRead> {
  const binary = await resolveBinary(host);
  if (!binary) {
    return {
      binary: null,
      json: null,
      status: { state: "not-installed", addresses: [], hints: notInstalledHints(host.platform) },
    };
  }

  // `--peers=false`, copied: a real tailnet's peer map overruns the host's
  // 64 KiB output cap, and a truncated document does not parse — which used to
  // report a healthy daemon as down. Every field read here is top-level.
  const result = await runTailscale(host, binary, ["status", "--json", "--peers=false"], {
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  // **Only a FAILED run is diagnosed, and only from stderr.** Copied whole
  // from `@subshell-ai/plugin-tailscale`: the matchers below are loose
  // substring tests, and a SUCCESSFUL `status --json` prints the whole
  // tailnet — ACL tags like `tag:operator`, peer names — which a stdout match
  // turned into a spurious `needs-privilege`.
  const failed = result.code !== 0;
  const diagnosis = failed ? result.stderr : "";

  if (looksLikePermissionDenied(diagnosis)) {
    return {
      binary,
      json: null,
      status: { state: "needs-privilege", addresses: [], hints: needsPrivilegeHints(likelyUserName(host.homeDir)) },
    };
  }

  const json = result.stdout.trim() === "" ? null : parseStatusJson(result.stdout);

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
    // The admin hint goes on EVERY needs-login row, `Stopped` included: on a
    // self-hosted tailnet the human clicking the link is only half the login,
    // and a machine nobody re-checks the admin side of waits silently.
    return {
      binary,
      json,
      status: {
        state: "needs-login",
        addresses: [],
        ...(authUrl ? { loginUrl: authUrl } : {}),
        identity,
        hints: [...needsLoginHints(json.BackendState, authUrl), adminHint()],
      },
    };
  }

  // **Ownership (the 2026-09-16 amendment to § 8's non-policing).** This row
  // may only claim a `Running` daemon that claims this control server back:
  // `debug prefs` names it, and the operator's live host was the bug report —
  // a Headscale row reading `Joined` (and publishable, since the serve check
  // reads the same foreign daemon) on a machine enrolled to Tailscale's SaaS.
  // FAIL-OPEN by design: prefs unreadable — no verb yet, refused, unparseable,
  // field absent — behaves exactly as § 8 left it, so the README's pick-one
  // rule survives on every CLI that cannot positively say otherwise.
  const prefsUrl = await readControlUrl(host, binary, { timeoutMs: PREFS_TIMEOUT_MS });
  if (prefsUrl !== undefined && !ownsDaemon(prefsUrl, ctx.settings.controlUrl)) {
    return {
      binary,
      json,
      status: {
        state: "needs-login",
        addresses: [],
        identity,
        hints: foreignControlServerHints(
          isTailscaleServiceControlUrl(prefsUrl) ? TAILSCALE_SERVICE_LABEL : controlServerHost(prefsUrl),
          normalizeControlUrl(ctx.settings.controlUrl),
        ),
      },
    };
  }

  // Difference 1, applied once and for everything downstream: the document's
  // `CertDomains` is not consulted at all. An https address is therefore
  // unconstructible here even when a future Headscale starts issuing
  // certificates, until this plugin is changed deliberately (§ 4).
  const addresses = tailnetAddresses(json, ctx.port);
  const hints: NetworkHint[] = [httpOnlyHint()];

  const published = await isServingThisPort(host, binary, ctx.port);
  return {
    binary,
    json,
    status: { state: published ? "published" : "joined", addresses, identity, hints },
  };
}

/**
 * Whether the daemon's own `ControlURL` names the control server this plugin
 * is configured with.
 *
 * An unset or unparseable setting is NOT a match, by decision: a Headscale
 * join requires the URL, so without one there is no daemon this row could
 * possibly own — and a preference the plugin cannot canonicalize cannot be
 * demonstrated equal to anything.
 */
function ownsDaemon(prefsUrl: string, setting: string | undefined): boolean {
  const wanted = normalizeControlUrl(setting);
  return wanted !== null && normalizeControlUrl(prefsUrl) === wanted;
}

/**
 * What this machine is called on this tailnet, for the UI's identity line.
 *
 * Copied from `@subshell-ai/plugin-tailscale`, and difference 3 lands here:
 * `network` is filled ONLY from `CurrentTailnet.Name`. A `MagicDNSSuffix` is
 * present on many headscale tailsnets and would make a tempting fallback —
 * § 4 says do not guess, so there is none.
 */
async function readIdentity(
  host: PluginHost,
  binary: string,
  json: TailscaleStatusJson,
): Promise<NetworkStatus["identity"]> {
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
 * The addresses this server can be reached at over the tailnet — all http.
 *
 * The name address first because the host promotes `addresses[0]` when asked
 * to set the base URL, and on a headscale tailnet the name IS the usable
 * address (the § 10.3 publish refusal points back at exactly this one).
 * `secureContext: false` on both says what the BROWSER will refuse there —
 * passkeys, `Secure` cookies — not that the traffic is unencrypted: the
 * tailnet's WireGuard carries it either way. The `Tailnet IP` label differs
 * from the origin's `Tailscale IP` because the address comes from this
 * operator's own control server, and naming the vendor's SaaS for it would be
 * exactly the confusion this plugin exists to avoid.
 */
function tailnetAddresses(json: TailscaleStatusJson, port: number): NetworkAddress[] {
  const addresses: NetworkAddress[] = [];
  const name = tailnetName(json);
  if (name) {
    addresses.push({ url: `http://${name}:${port}`, scheme: "http", label: "MagicDNS", secureContext: false });
  }
  for (const ip of tailnetIpv4s(json)) {
    addresses.push({ url: `http://${ip}:${port}`, scheme: "http", label: "Tailnet IP", secureContext: false });
  }
  return addresses;
}

/**
 * Whether `tailscale serve` is already proxying this server's port.
 *
 * Copied verbatim from `@subshell-ai/plugin-tailscale`'s `src/status.ts` —
 * § 4 keeps the published check reading `tailscale serve status`. It searches
 * the serialized document for the proxy-target string rather than walking a
 * shape that has changed across releases, anchored so port `3080` cannot
 * match a target on `30800`.
 */
async function isServingThisPort(host: PluginHost, binary: string, port: number): Promise<boolean> {
  const result = await runTailscale(host, binary, ["serve", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  if (result.code !== 0) return false;
  const parsed = parseStatusJson(result.stdout);
  const haystack = parsed ? JSON.stringify(parsed) : result.stdout;
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
 * Copied from `@subshell-ai/plugin-tailscale`'s `src/status.ts`, minus the
 * certificate advice — there is no certificates switch to reach. {@link
 * readNetwork} appends {@link adminHint} to everything this returns.
 */
function needsLoginHints(backendState: string | undefined, authUrl: string | undefined): NetworkHint[] {
  if (backendState === "Stopped") {
    return [
      {
        text: "Tailscale is installed and switched off. Turn it back on — this page will notice when you do.",
        command: "tailscale up",
      },
    ];
  }
  if (authUrl) {
    return [{ text: "Finish signing in to Tailscale to put this machine on your tailnet.", docsUrl: authUrl }];
  }
  return [{ text: "This machine is not on a tailnet yet. Join one to reach this server from your other devices." }];
}
