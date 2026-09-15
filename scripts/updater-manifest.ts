/**
 * The desktop updater's `latest.json`: its shape, its names, and the merge
 * (spec 2026-09-15 § 8).
 *
 * `tauri-plugin-updater` reads ONE static JSON document per release, listing
 * every platform's download URL and its minisign signature. This repository
 * builds one platform per SHARD, so no single shard can write that document —
 * each writes `latest.<triple>.json` beside its own artifacts, and the publish
 * job (which is where all the shards' outputs first exist together) merges them
 * into `latest.json` before the draft upload.
 *
 * Three facts about the URLs in it, and each is the reason this can be written
 * before the release exists:
 *
 * - **The tag is chosen by this repository**, not by the bundler
 *   (`release.yml`'s plan job, `<app>-v<version>`).
 * - **So is every asset name** (`desktopArtifactFileName`). What Tauri emits
 *   is DISCOVERED and renamed; what is published is ours.
 * - **So the download URL is knowable at build time.** Nothing here reads the
 *   GitHub API, and a release that has not been created yet is not a problem
 *   to solve — it is the ordinary case.
 *
 * Kept in `scripts/` rather than in `@internal/subshell-protocol` because the
 * merge half is a CI step with no runtime consumer, and the write half is used
 * by exactly two release pipelines that already reach for repo-root scripts.
 */

// By PATH, like every other root script reaches the protocol package
// (`desktop-dev.ts` does the same): the repo root is not a workspace that
// depends on it, and adding that edge to run a URL builder would be a
// dependency for a constant.
import { SUBSHELL_REPO_SLUG } from "../packages/subshell-protocol/src/releases.js";

/** The updater manifest's file name for one shard's platform. */
export function latestManifestName(target: string): string {
  return `latest.${target}.json`;
}

/** The merged manifest's file name — the one asset the plugin is pointed at. */
export const LATEST_MANIFEST_NAME = "latest.json";

/**
 * Tauri's own platform key for one of this repo's desktop targets.
 *
 * The updater matches on `<os>-<arch>` in ITS spelling, which is not this
 * repo's: `aarch64` and `x86_64` where `DESKTOP_TARGETS` says `arm64` and
 * `x64`. A manifest written with the wrong key is not an error anywhere — the
 * plugin simply finds no entry for the running platform and reports "no
 * update", forever.
 */
export function updaterPlatformKey(target: string): string {
  if (target === "darwin-arm64") return "darwin-aarch64";
  if (target === "linux-x64") return "linux-x86_64";
  throw new Error(`no updater platform key for '${target}'`);
}

/**
 * The updater ARTIFACT this repo publishes for a target, derived from the
 * published bundle name.
 *
 * macOS ships a `.app.tar.gz` (the DMG is for humans; the plugin replaces an
 * installed `.app` from a tarball), and Linux ships the `.deb` ITSELF — the
 * plugin hands it to `dpkg`. So the Linux updater artifact IS the published
 * bundle, and only macOS has a second file.
 *
 * Derived from `desktopArtifactFileName`'s output rather than re-spelled, so
 * the two names cannot drift and the published-name rules (space-free, and
 * carrying the `Desktop` token) hold for the updater assets by construction.
 *
 * @param bundleName - what `desktopArtifactFileName` produced for this target
 * @param target - a `DESKTOP_TARGETS` member
 */
export function updaterArtifactName(bundleName: string, target: string): string {
  if (target === "darwin-arm64") {
    if (!bundleName.endsWith(".dmg")) throw new Error(`expected a .dmg for ${target}, got '${bundleName}'`);
    return `${bundleName.slice(0, -".dmg".length)}.app.tar.gz`;
  }
  if (target === "linux-x64") return bundleName;
  throw new Error(`no updater artifact name for '${target}'`);
}

/** One platform's entry in the manifest. */
export interface UpdaterPlatform {
  /** The `.sig` file's contents, inline — that is how the plugin wants it. */
  signature: string;
  /** Where the artifact will be, once the release is published. */
  url: string;
}

/** The whole document, in the plugin's static shape. */
export interface UpdaterManifest {
  version: string;
  /** The release page — the plugin shows this as the update's notes. */
  notes: string;
  /** RFC 3339, which the plugin parses. */
  pub_date: string;
  platforms: Record<string, UpdaterPlatform>;
}

/** Where a published asset lands, for a tag this repository chose. */
export function assetDownloadUrl(tag: string, asset: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/download/${tag}/${encodeURIComponent(asset)}`;
}

/** The release page a manifest's `notes` points at. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${tag}`;
}

/**
 * One shard's manifest: the document, with exactly one platform in it.
 *
 * @param input.version - the app version this shard built
 * @param input.tag - the release tag (`<app>-v<version>`)
 * @param input.target - a `DESKTOP_TARGETS` member
 * @param input.asset - the updater artifact's published name
 * @param input.signature - the `.sig` file's contents, verbatim
 * @param input.publishedAt - RFC 3339; defaults to now
 */
export function buildShardManifest(input: {
  version: string;
  tag: string;
  target: string;
  asset: string;
  signature: string;
  publishedAt?: string;
}): UpdaterManifest {
  const signature = input.signature.trim();
  if (signature === "") throw new Error(`the updater signature for ${input.target} is empty`);
  return {
    version: input.version,
    notes: releasePageUrl(input.tag),
    pub_date: input.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      [updaterPlatformKey(input.target)]: {
        signature,
        url: assetDownloadUrl(input.tag, input.asset),
      },
    },
  };
}

/**
 * Merge every shard's manifest into the one the plugin reads.
 *
 * Pure, and strict about the two things that would produce a manifest nobody
 * can use:
 *
 * - **Every shard must agree on the version.** Two shards built from
 *   different commits would otherwise publish one manifest offering platform A
 *   one version and platform B another, under a single `version` field that is
 *   right for at most one of them — and the plugin compares against that field,
 *   so half the fleet would be told the wrong thing.
 * - **No platform may be claimed twice.** A duplicate means two shards built
 *   the same target, which is a matrix bug; picking one silently would publish
 *   an arbitrary binary under a canonical name — the same refusal
 *   `selectBundleOutput` makes for the same reason.
 *
 * `pub_date` and `notes` come from the FIRST shard, which is why the version
 * check is the one that matters: with one version there is one release, one
 * page and one moment.
 *
 * @param expected - every platform key the merged document must carry
 *   ({@link DESKTOP_TARGETS} through {@link updaterPlatformKey}). Omitting it
 *   checks only that SOMETHING survived, which is what the merge did at first
 *   and is not enough: a manifest naming one of two platforms publishes
 *   cleanly and tells the other platform's installed apps "no updates"
 *   forever, which is the exact silent failure this module exists to prevent.
 *   The publish job's `needs: [plan, build]` already means a missing shard
 *   fails the release before this runs, so this is the second lock on the
 *   same door rather than the only one.
 */
export function mergeUpdaterManifests(
  shards: readonly UpdaterManifest[],
  expected?: readonly string[],
): UpdaterManifest {
  if (shards.length === 0) throw new Error("no latest.<triple>.json files to merge");
  const [first, ...rest] = shards as [UpdaterManifest, ...UpdaterManifest[]];
  const platforms: Record<string, UpdaterPlatform> = {};
  for (const shard of [first, ...rest]) {
    if (shard.version !== first.version) {
      throw new Error(`shard manifests disagree on the version: ${first.version} vs ${shard.version}`);
    }
    for (const [key, value] of Object.entries(shard.platforms)) {
      if (platforms[key] !== undefined) throw new Error(`two shards both claim the platform '${key}'`);
      platforms[key] = value;
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error("the merged manifest names no platform");
  const missing = (expected ?? []).filter((key) => platforms[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `the merged manifest is missing ${missing.join(", ")} — publishing it would tell those platforms' installed apps there are no updates`,
    );
  }
  return { version: first.version, notes: first.notes, pub_date: first.pub_date, platforms };
}

/**
 * Parse a shard manifest, refusing anything that is not one.
 *
 * Narrow on purpose: this runs in the publish job over files downloaded from
 * the build shards, and a document that merged cleanly while missing a
 * signature would publish an update every installed app refuses — which looks
 * exactly like "there are no updates".
 */
export function parseShardManifest(text: string, where: string): UpdaterManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const doc = value as Partial<UpdaterManifest>;
  if (typeof doc?.version !== "string" || doc.version === "") throw new Error(`${where} has no version`);
  if (typeof doc.notes !== "string") throw new Error(`${where} has no notes`);
  if (typeof doc.pub_date !== "string") throw new Error(`${where} has no pub_date`);
  if (doc.platforms === undefined || typeof doc.platforms !== "object") {
    throw new Error(`${where} has no platforms`);
  }
  for (const [key, entry] of Object.entries(doc.platforms)) {
    if (typeof entry?.signature !== "string" || entry.signature.trim() === "") {
      throw new Error(`${where} carries no signature for '${key}'`);
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) {
      throw new Error(`${where} carries no https url for '${key}'`);
    }
  }
  return doc as UpdaterManifest;
}
