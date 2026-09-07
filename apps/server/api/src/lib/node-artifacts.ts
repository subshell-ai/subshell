import { type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { NODE_TARGETS, type NodeTarget, nodeArtifactFileName } from "@internal/subshell-protocol";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";

/**
 * The on-disk truth of which node agent binaries THIS instance can serve —
 * shared by the download routes (what to serve), `GET /api/settings/public`
 * (what the Nodes dialog may promise) and `subshell-server status` (what the
 * operator should see before anyone hits the wall). Lives here, not in the
 * route module, because the CLI's import graph must stay IO-free and these
 * helpers are pure fs reads.
 */

/** Absolute path of a target's binary. `target` is the route's isNodeTarget-gated value. */
export function artifactPath(target: NodeTarget): string {
  return join(NODE_ARTIFACTS_DIR, nodeArtifactFileName(target));
}

/**
 * The single published-artifact rule: a build is published only when a
 * regular, NON-EMPTY file sits at the target's path — a zero-length artifact
 * (partial write, deliberate stub) is unpublished, never served as a 200 and
 * never digested as the sha of "". The binary and sha routes share it so they
 * 404 identically for the same on-disk state.
 * @returns the file's stat, or null when unpublished (missing / not a file / empty)
 */
export function artifactStat(target: NodeTarget): Stats | null {
  try {
    const stat = statSync(artifactPath(target));
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null; // ENOENT/ENOTDIR → unpublished → 404 upstream
  }
}

/**
 * The targets this instance ACTUALLY serves — the same rule as
 * {@link artifactStat}, widened to the whole closed set. A binary-only
 * server install (GitHub release) ships an EMPTY artifacts dir, which nothing
 * populates until `release:client` publishes to it; until then the enroll
 * one-liner 404s on every machine, and this list is how the dialog and the
 * operator's own `status` know that instead of discovering it.
 */
export function publishedNodeTargets(): NodeTarget[] {
  return NODE_TARGETS.filter((target) => artifactStat(target) !== null);
}
