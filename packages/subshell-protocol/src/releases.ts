/**
 * Which release of a component is the newest one, and what it is called.
 *
 * Generalized from `node-release.ts` (spec 2026-09-15 §3.1), which knew only
 * about agent binaries. Every component now updates from the same list with
 * the same code: the server updates itself, a node updates itself, and the two
 * desktop apps are pointed at their own releases by the Updates page.
 *
 * Everything here is PURE — parsing tags, picking the newest, naming an asset,
 * parsing a manifest. The fetching, verifying and caching is the server's
 * (`services/releases.ts`), because it is I/O and because the decision to
 * reach the network at all belongs to the side that holds the operator's
 * configuration. That split is also what keeps this module on the Metro-safe
 * barrel: it imports no `node:` builtin.
 */
import { type NodeTarget, nodeArtifactFileName, type ServerTarget, serverArtifactFileName } from "./paths.js";
import { semverLt } from "./versions.js";

/** The repository these binaries are published from. */
export const SUBSHELL_REPO_SLUG = "subshell-ai/subshell";

/**
 * The releases endpoint anything reading this repository's releases uses.
 *
 * The LIST endpoint rather than `/releases/latest`: "latest" is a property of
 * the whole repository, and this repo publishes four app components plus a
 * release per npm package, so the latest release is very often not the one a
 * caller wants (measured 2026-09-15: `server-v0.6.0` beat `node-v0.8.0` by
 * seconds). The caller filters by tag prefix instead.
 *
 * `per_page=100` rather than the API's default 30: merging ONE version PR can
 * publish four app releases plus seven npm package releases, so a default page
 * can miss a whole component — which would read as "there is no newer server"
 * rather than as a truncated list.
 */
export const DEFAULT_RELEASE_API = `https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases?per_page=100`;

/**
 * The four things this repository cuts releases of — the release-component
 * IDS (`release.yml`'s `matrix.app`), never the directory names.
 */
export type ReleaseComponent = "server" | "node" | "desktop-server" | "desktop-client";

/** Every component, for iteration and validation. */
export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = ["server", "node", "desktop-server", "desktop-client"];

/**
 * The git tag prefix each component publishes under.
 *
 * Note that `desktop-server-v` has `server-v` as a suffix but NOT as a prefix,
 * which is why {@link parseReleaseTag} can be a plain `startsWith` — but it is
 * also why {@link newestRelease} must be given a component rather than
 * inferring one from a tag.
 */
export const RELEASE_TAG_PREFIX: Record<ReleaseComponent, string> = {
  server: "server-v",
  node: "node-v",
  "desktop-server": "desktop-server-v",
  "desktop-client": "desktop-client-v",
};

/**
 * The version inside a `<component>-vX.Y.Z` tag, or null for any other tag.
 *
 * Three numeric parts, nothing else. A prerelease or build-metadata suffix is
 * deliberately NOT accepted: an updater would then be handing a machine a
 * build the release pipeline does not smoke-test the same way.
 */
export function parseReleaseTag(component: ReleaseComponent, tag: string): string | null {
  const prefix = RELEASE_TAG_PREFIX[component];
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** One release, reduced to what choosing between them needs. */
export interface ReleaseCandidate {
  tag: string;
  version: string;
}

/**
 * The newest release of ONE component among a repository's tags.
 *
 * Compared by SEMVER, never by the order the API returned or by date: a re-cut
 * of an older version publishes later than a newer one, and a date-ordered
 * pick would then hand every machine a downgrade.
 *
 * Tags belonging to another component are ignored even when they would parse
 * as a newer version — `desktop-server-v9.0.0` is not a server release.
 */
export function newestRelease(component: ReleaseComponent, tags: readonly string[]): ReleaseCandidate | null {
  let best: ReleaseCandidate | null = null;
  for (const tag of tags) {
    const version = parseReleaseTag(component, tag);
    if (version === null) continue;
    if (best === null || semverLt(best.version, version)) best = { tag, version };
  }
  return best;
}

/**
 * The two asset names a CLI release carries for one platform.
 *
 * Only `server` and `node` have bare-binary assets; the two desktop components
 * publish bundles whose names carry a version and are built by
 * `desktopArtifactFileName`, so they are not nameable from a target alone.
 */
export function releaseAssetNames(
  component: "server" | "node",
  target: NodeTarget | ServerTarget,
): { binary: string; sidecar: string } {
  const binary = component === "node" ? nodeArtifactFileName(target) : serverArtifactFileName(target);
  return { binary, sidecar: `${binary}.sha256` };
}

/**
 * The digest out of a `.sha256` asset's bytes.
 *
 * This repo's own sidecars are a bare lowercase 64-hex digest and a newline
 * (`release-artifacts.ts`), but `sha256sum` writes `<digest>  <filename>` and
 * a release could carry either — the downloads route's reader already
 * tolerates both, so this one does too rather than being the stricter of two
 * readers of the same file.
 *
 * @returns the lowercase digest, or null when the bytes are not one
 */
export function parseSidecarDigest(text: string): string | null {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/.test(first) ? first : null;
}

/**
 * The fifth asset every app release carries (spec 2026-09-15 §3.2).
 *
 * It exists so a control plane can answer "is this node release compatible
 * with me" without downloading an 80 MB binary: the node release it offers is
 * the newest one whose `nodeProtocol` equals its own. A release WITHOUT this
 * asset — every cut before 2026-09-15 — is treated as unknown and is not
 * offered; the Updates page says so rather than guessing.
 */
export const RELEASE_MANIFEST_NAME = "release-manifest.json";

/** What {@link RELEASE_MANIFEST_NAME} carries. */
export interface ReleaseManifest {
  /** Which of the four components this release is. */
  component: ReleaseComponent;
  /** The version, matching the tag's own `X.Y.Z`. */
  version: string;
  /** `NODE_PROTOCOL_VERSION` as of this build — the compatibility question. */
  nodeProtocol: number;
  /** `MIN_AGENT_VERSION` as of this build. */
  minAgentVersion: string;
  /** The commit the release was cut from (`GITHUB_SHA`, else `git rev-parse HEAD`). */
  commit: string;
}

/**
 * Parse a `release-manifest.json` asset's bytes.
 *
 * Strict by field, and null rather than a throw on anything unexpected: the
 * caller's answer to "no manifest" and "an unreadable manifest" is the same
 * one — do not offer this release — and a release published by some future
 * pipeline is not a reason to fail a page that is only asking what is
 * available.
 */
export function parseReleaseManifest(text: string): ReleaseManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { component, version, nodeProtocol, minAgentVersion, commit } = parsed as Record<string, unknown>;
  if (typeof component !== "string" || !(RELEASE_COMPONENTS as readonly string[]).includes(component)) return null;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (typeof nodeProtocol !== "number" || !Number.isInteger(nodeProtocol)) return null;
  if (typeof minAgentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(minAgentVersion)) return null;
  if (typeof commit !== "string" || commit === "") return null;
  return { component: component as ReleaseComponent, version, nodeProtocol, minAgentVersion, commit };
}

/**
 * Which published artifact THIS host runs, from `process.platform`/`process.arch`.
 *
 * `null` is a real answer with a real population behind it — an Intel Mac, a
 * 32-bit Linux, a BSD — and every caller refuses BY NAME rather than guessing
 * a nearby triple, exactly as `install-server.sh` does. `SERVER_TARGETS` and
 * `NODE_TARGETS` are the same three strings today, so one function answers for
 * both; the return type is `ServerTarget` because that is the wider promise.
 */
export function hostReleaseTarget(platform: string, arch: string): ServerTarget | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return null;
}
