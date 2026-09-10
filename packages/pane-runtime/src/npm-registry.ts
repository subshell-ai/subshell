/**
 * The npm registry client for plugin installs (spec 2026-09-09 §2.7): spec
 * parsing, packument resolution, and integrity-verified tarball fetch.
 *
 * No dependency on the tar reader: integrity is verified over the RAW
 * downloaded bytes, before anything is unpacked or written, so a mismatch
 * means nothing was installed. The registry URL is operator-configurable
 * (an http mirror is the motivating case); the hash only ever proves the
 * bytes match what the SAME registry announced, never more than that.
 */
import { createHash } from "node:crypto";

/**
 * npm's package-name grammar, anchored, scoped | plain. The leading classes
 * deliberately exclude `-`: names may contain hyphens but not START with one,
 * so `-x` is refused while `a-` and `~x` pass. (The brief's draft had the
 * hyphen inside the leading class, where JS reads it as a literal, so the
 * test-suite's own `-x` refusal case did not hold; this is the deviation.)
 */
const NAME_RE = /^(?:@[a-z0-9~][a-z0-9-*._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const TAG_RE = /^[a-z][a-z0-9._-]*$/;

/** The default when no `registryUrl` is configured (spec §2.7). */
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

/** A parsed `name[@version-or-tag]` install spec. */
export interface PackageSpec {
  /** The npm package name, scoped or plain. */
  name: string;
  /** An exact version or a dist-tag; RANGES are refused here, not half-resolved. */
  range?: string;
}

/**
 * Splits `name[@version-or-tag]`. The split point is the LAST `@` after
 * position 0 — a scoped name's `@` is at 0 by definition. `@scope/pkg` is
 * name-only; `pkg@1.2.3` and `pkg@latest` pin.
 */
export function parsePackageSpec(spec: string): PackageSpec {
  const at = spec.lastIndexOf("@");
  let name = spec;
  let range: string | undefined;
  if (at > 0) {
    name = spec.slice(0, at);
    range = spec.slice(at + 1);
  }
  if (!NAME_RE.test(name)) throw new Error(`'${spec}' is not a valid npm package name`);
  if (range !== undefined && !(VERSION_RE.test(range) || TAG_RE.test(range))) {
    throw new Error(
      `'${range}' is not a version or dist-tag: registry installs take exact versions or tags, not ranges`,
    );
  }
  return range === undefined ? { name } : { name, range };
}

/** What a registry packument promises about one version: fetch these bytes, match this hash. */
export interface ResolvedVersion {
  /** The concrete semver the range resolved to. */
  version: string;
  /** `dist.tarball`: absolute, or relative to the registry base. */
  tarball: string;
  /** `dist.integrity`: an SRI `sha512-<base64>` digest of the tarball bytes. */
  integrity: string;
}

/** Packument shape this client reads: abbreviated ("corgi") or full, it only touches these fields. */
interface Packument {
  "dist-tags"?: Record<string, unknown>;
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } } | undefined>;
}

/** Fetch the abbreviated packument. Every refusal names the URL it tried (spec §2.5). */
async function getPackument(name: string, registryUrl: string): Promise<Packument> {
  // Each path segment encoded: a scoped name must reach the registry as
  // `%40scope/pkg`, never a raw `@` (registries and proxies route the encoded form).
  const url = `${registryUrl.replace(/\/+$/, "")}/${name.split("/").map(encodeURIComponent).join("/")}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(
      `could not reach the registry at ${registryUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new Error(`the registry at ${url} answered ${res.status} for '${name}'`);
  try {
    return (await res.json()) as Packument;
  } catch (err) {
    // An HTML proxy or captive-portal body answers 200 with no JSON at all —
    // a bare `SyntaxError` naming no URL is not a refusal a caller can act on.
    throw new Error(
      `the registry at ${url} did not answer with JSON for '${name}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolves `name` + exact-version-or-dist-tag against the registry's packument.
 * `range === undefined` means `latest`. A version with no sha512 integrity is
 * refused outright: no hash, no install (spec §2.7).
 */
export async function resolvePackageVersion(
  name: string,
  range: string | undefined,
  registryUrl = DEFAULT_REGISTRY_URL,
): Promise<ResolvedVersion> {
  const doc = await getPackument(name, registryUrl);
  // `Object.hasOwn`, not a truthy index: `range` is caller-influenced (it is
  // the version/tag off the install spec) and both objects are `JSON.parse`
  // output, so a key like `constructor` must not resolve through the
  // prototype chain. Failing closed here is honesty, not a hole — a bogus
  // hit would still be refused below by the `dist.tarball`/`dist.integrity`
  // checks — but it should say no for the right reason.
  const version =
    range === undefined
      ? (doc["dist-tags"]?.latest as string | undefined)
      : doc.versions && Object.hasOwn(doc.versions, range)
        ? range
        : doc["dist-tags"] && Object.hasOwn(doc["dist-tags"], range)
          ? (doc["dist-tags"][range] as string | undefined)
          : undefined;
  if (typeof version !== "string") throw new Error(`'${name}' has no ${range ?? "latest"} version at ${registryUrl}`);
  const dist = doc.versions?.[version]?.dist;
  if (
    typeof dist?.tarball !== "string" ||
    typeof dist?.integrity !== "string" ||
    !dist.integrity.startsWith("sha512-")
  ) {
    throw new Error(
      `'${name}@${version}' carries no sha512 integrity hash, and the install refuses to run without one`,
    );
  }
  return { version, tarball: dist.tarball, integrity: dist.integrity };
}

/**
 * Downloads the resolved tarball and verifies its sha512 over the RAW bytes,
 * before anything is unpacked or written. Nothing larger than 20 MiB is
 * accepted (spec §2.8).
 */
export async function fetchVerifiedTarball(
  resolved: ResolvedVersion,
  registryUrl = DEFAULT_REGISTRY_URL,
): Promise<Uint8Array> {
  // A mirror may rewrite `dist.tarball` to its own host or a CDN (verdaccio does).
  // Fetch the announced URL as-is and verify against the integrity the SAME
  // registry announced in the same packument: that is the §2.7 trust statement.
  // Integrity only ever proves the bytes match the hash that server published.
  // Over the default https URL that is npm's own assurance; over an http mirror
  // it is the operator's own network.
  const url = resolved.tarball.startsWith("http")
    ? resolved.tarball
    : `${registryUrl.replace(/\/+$/, "")}/${resolved.tarball.replace(/^\/+/, "")}`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`tarball for ${resolved.version} exceeds 20 MiB`);
  const seen = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (seen !== resolved.integrity) {
    throw new Error(
      `integrity mismatch for '${resolved.version}': the registry announced a different digest, and nothing was written`,
    );
  }
  return bytes;
}
