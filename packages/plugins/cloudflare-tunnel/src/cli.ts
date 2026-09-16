import type { NetworkAddress, NetworkContext, PluginHost } from "@subshell-ai/plugin-api";
import { manifest } from "./manifest.js";

/**
 * Binary lookup, token shape, and settings normalization — the three things
 * this plugin shares between its verbs, none of which touches a process.
 *
 * `cloudflared` is the one connector this suite may install itself (§ 8: no
 * root anywhere), but the plugin still runs NOTHING. The tunnel it needs is
 * described to the host as a {@link SupervisedProcessSpec-like} declaration
 * and the host spawns it; every verb here is a lookup, a shape check, or a
 * settings read.
 */

/** The binary name, env override and known install locations, from the manifest. */
const DETECT = manifest.detect;

/** Where Cloudflare documents downloading `cloudflared`, per platform. */
export const DOWNLOADS_DOCS_URL =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/**
 * The secret name the tunnel token lives under.
 *
 * It is also the settings field's KEY, because the host stores each secret
 * under the declared field's key and secret names are file names — lowercase
 * letters, digits and hyphens. A camelCase key would make this field
 * permanently unsettable, which is why the spec's `tunnelToken` spelling
 * could not survive contact with {@link PluginHost.secrets}.
 */
export const TOKEN_SECRET = "tunnel-token";

/**
 * Resolves the `cloudflared` binary through the host's own lookup ladder.
 *
 * Reads the manifest rather than repeating the three detection values, so the
 * data a host scans a machine with (without loading this file) and the data
 * this file runs against cannot drift apart. `.local/bin/cloudflared` is
 * HOME-relative; the two absolute entries are what answer on machines whose
 * service PATH reaches neither Homebrew dir.
 */
export async function resolveBinary(host: PluginHost): Promise<string | null> {
  if (!DETECT) return null;
  return host.findBinary(DETECT.binaryName, DETECT.envOverride, DETECT.knownPaths);
}

/**
 * The first non-blank line of some output, for a hint or an identity line.
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
 * Whether a string is the shape of a Cloudflare tunnel token.
 *
 * The connector token Zero Trust mints is base64 of a small JSON document
 * carrying the account/tunnel/secret triple (`a`, `t`, `s`). Checking the
 * shape before storing it is cheap and turns "paste the wrong thing" into an
 * immediate, specific sentence — the same reason the auth-key prefix is
 * checked before `tailscale up` ever runs.
 *
 * Both base64 spellings are accepted: Cloudflare hands out the standard one,
 * but a token round-tripped through a JSON API can come back URL-safe, and
 * `+`/`-` are indistinguishable by anything but decoding.
 */
export function isTunnelTokenShape(raw: string | undefined): boolean {
  const value = raw?.trim() ?? "";
  if (value === "") return false;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return (["a", "t", "s"] as const).every((key) => typeof record[key] === "string" && (record[key] as string) !== "");
  } catch {
    return false;
  }
}

/** The settings one publish needs, all of them already normalized. */
export interface TunnelSettings {
  /** Bare lowercase hostname — what the guard's Host comparison and the pre-flight URL are built from. */
  hostname: string;
  /** Fully-qualified Access host, `<team>.cloudflareaccess.com` — the issuer and JWKS host the guard verifies against. */
  teamDomain: string;
  /** The Access application's Audience tag. */
  aud: string;
}

/** A bare public hostname: labels, dots, no scheme, no port, no path. */
const BARE_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A bare Access team slug. */
const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A stored hostname reduced to the bare form, or null.
 *
 * Deliberately forgiving at READ time — people paste `https://…/` into fields
 * the placeholder shows as bare, and the guard compares this string against a
 * Host header, so a scheme that survives into here is a guard that never
 * matches. The strict spelling is enforced at WRITE time by
 * {@link validateTunnelSettings}, so the forgiving read is a belt, not the
 * contract.
 */
export function normalizeHostname(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/)[0] ?? "";
  const host = authority.split("@").pop() ?? "";
  // A port is meaningless here: the tunnel's public hostname answers on 443
  // and routes to the local port the dashboard ingress names.
  const bare = host.replace(/:\d+$/, "").replace(/\.+$/, "");
  return BARE_HOSTNAME_RE.test(bare) ? bare : null;
}

/**
 * A stored team domain reduced to `<team>.cloudflareaccess.com`, or null.
 *
 * The guard spec wants the ISSUER host (`https://<team>.cloudflareaccess.com`
 * is what its JWT is verified against and where its JWKS lives), while the
 * settings field asks for the team slug. This is the one place that knows the
 * two spellings and reconciles them — accepting a bare slug and a pasted full
 * host alike.
 */
export function normalizeTeamDomain(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = (withoutScheme.split(/[/?#]/)[0] ?? "").replace(/\.+$/, "");
  if (host === "") return null;
  if (host.endsWith(".cloudflareaccess.com") && BARE_HOSTNAME_RE.test(host)) return host;
  if (TEAM_SLUG_RE.test(host)) return `${host}.cloudflareaccess.com`;
  return null;
}

/**
 * The three settings publish and the guard are built from, or null when any
 * is absent or malformed.
 *
 * Null rather than a partial: a half-configured publish is exactly what the
 * refusal sentence exists to name, and letting one field through malformed
 * would put a bad hostname in front of a live Host-header comparison.
 */
export function readSettings(ctx: NetworkContext): TunnelSettings | null {
  const hostname = normalizeHostname(ctx.settings.hostname);
  const teamDomain = normalizeTeamDomain(ctx.settings.teamDomain);
  const aud = (ctx.settings.aud ?? "").trim();
  if (hostname === null || teamDomain === null || aud === "") return null;
  return { hostname, teamDomain, aud };
}

/** The public address this server is published at, once its tunnel is up. */
export function tunnelAddress(hostname: string): NetworkAddress {
  // No port: the edge terminates TLS and the ingress maps the hostname to
  // this server's local port. `secureContext: true` is the whole point of the
  // plugin — the one address in the set a browser treats as secure.
  return { url: `https://${hostname}`, scheme: "https", label: "Public hostname", secureContext: true };
}
