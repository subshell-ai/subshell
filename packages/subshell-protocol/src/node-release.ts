/**
 * Where a control plane can get node agent binaries it does not have.
 *
 * A server installed from a release tarball ships an EMPTY `node-artifacts`
 * directory, so `GET /api/downloads/node/*` 404s on every platform until
 * someone runs `release:node` from a checkout or copies assets in by hand.
 * That was the only answer while this repository was private. It is public
 * now, and the same release the operator was being told to copy from is one
 * the server can read itself.
 *
 * Everything here is PURE — parsing tags, picking the newest, naming an
 * asset. The fetching, verifying and caching is the server's
 * (`services/node-release.ts`), because it is I/O and because the decision to
 * reach the network at all belongs to the side that holds the operator's
 * configuration.
 */
import { type NodeTarget, nodeArtifactFileName } from "./paths.js";
import { semverLt } from "./versions.js";

/** The repository these binaries are published from. */
export const SUBSHELL_REPO_SLUG = "subshell-ai/subshell";

/**
 * The releases endpoint a control plane reads when it needs a binary.
 *
 * The LIST endpoint rather than `/releases/latest`: "latest" is a property of
 * the whole repository, and this repo publishes four app components plus a
 * release per npm package, so the latest release is very often not a node one
 * (measured — the seven `@subshell-ai/*` releases sit above `node-v0.2.0` by
 * date). The caller filters by tag prefix instead.
 */
export const DEFAULT_NODE_RELEASE_API = `https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases`;

/** Tag prefix for the node agent's own releases — `release.yml`'s `node` component id. */
export const NODE_RELEASE_TAG_PREFIX = "node-v";

/** The version inside a `node-vX.Y.Z` tag, or null for any other tag. */
export function parseNodeReleaseTag(tag: string): string | null {
  if (!tag.startsWith(NODE_RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(NODE_RELEASE_TAG_PREFIX.length);
  // Three numeric parts, nothing else. A prerelease or build-metadata suffix
  // is deliberately NOT accepted: the plane would be handing a node a build
  // the release pipeline does not smoke-test the same way.
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** One release, reduced to what choosing between them needs. */
export interface NodeReleaseCandidate {
  tag: string;
  version: string;
}

/**
 * The newest node release among a repository's tags.
 *
 * Compared by SEMVER, never by the order the API returned or by date: a
 * re-cut of an older version publishes later than a newer one, and a
 * date-ordered pick would then hand every new node a downgrade.
 */
export function newestNodeRelease(tags: readonly string[]): NodeReleaseCandidate | null {
  let best: NodeReleaseCandidate | null = null;
  for (const tag of tags) {
    const version = parseNodeReleaseTag(tag);
    if (version === null) continue;
    if (best === null || semverLt(best.version, version)) best = { tag, version };
  }
  return best;
}

/** The two asset names a release carries for one platform. */
export function nodeReleaseAssetNames(target: NodeTarget): { binary: string; sidecar: string } {
  const binary = nodeArtifactFileName(target);
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
