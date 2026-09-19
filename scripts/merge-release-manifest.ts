#!/usr/bin/env bun
/**
 * Merge the build shards' `release-manifest.json` files into the ONE signed
 * manifest a release publishes (spec 2026-09-17 §7).
 *
 * ```
 * bun scripts/merge-release-manifest.ts <dir> [--out <dir>]
 * ```
 *
 * Why a merge step exists at all: every build shard writes its OWN
 * `release-manifest.json` beside its artifact (the local `release:cli-node` run
 * writes one because it builds every triple in a single process; CI does not
 * — it runs one shard per triple). Before the `assets` map, those per-shard
 * files were byte-identical, so softprops' upload-by-basename collision was
 * harmless. Since spec 2026-09-17 each names only ITS OWN artifact in
 * `assets`, and the last shard uploaded would silently win — publishing a
 * release whose signed manifest names one platform and refuses every node on
 * the others ("the signed manifest names no linux-arm64 asset"), which is a
 * per-machine dead end discovered by whoever's laptop does not update. This
 * step is the same shape as `merge-updater-manifests.ts`: the publish job is
 * the first moment all platforms exist together, and the merged + freshly
 * signed pair is listed explicitly in the asset list (the per-shard copies
 * are deleted before upload so the glob cannot collide with them).
 *
 * `<dir>` is searched at the top level and one directory deep, because
 * `download-artifact` lands each shard in its own subdirectory
 * (`dist/server-linux-x64/…`). The merged files go to `--out`, ABOVE those
 * directories.
 *
 * Refusals, all release-stopping: no shard manifests; shards that disagree
 * on component/version/nodeProtocol/minAgentVersion/commit (a half-cut, or
 * two versions in one release — either way nobody can say what was published);
 * two shards naming one asset with different digests (the exact
 * two-artifacts-for-one-tag state the signature exists to catch); and, for
 * the `server`/`node` components, a merged set missing any target platform's
 * binary — a missing entry is invisible to everyone but the machine that
 * needed it. A missing `TAURI_SIGNING_PRIVATE_KEY` also refuses: unlike the
 * shards (where an unsigned local publish is legitimate), this script runs
 * only in the publish job, whose secrets the shard steps already proved
 * present — so its absence is a broken cut, and an unsigned merged manifest
 * is a release no plane will offer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NODE_TARGETS, SERVER_TARGETS } from "../packages/subshell-protocol/src/paths.js";
import { signPublishedReleaseManifest } from "../packages/subshell-protocol/src/release-signature.js";
import {
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  type ReleaseManifest,
  releaseAssetNames,
} from "../packages/subshell-protocol/src/releases.js";

/** One shard's manifest, with the file it came from so every refusal can name it. */
export interface ShardManifest {
  /** The shard file's path (used in refusal messages only). */
  origin: string;
  manifest: ReleaseManifest;
}

/**
 * Every `release-manifest.json` under `dir`, at the top level or one
 * directory down. Sorted, so a merge is reproducible and a failure names a
 * stable file. The destination's own manifest is ALWAYS excluded, `--out`
 * given or not — the write happens after the scan, so the file about to be
 * written can never be a shard it needs to read, and re-running without
 * `--out` in a reused directory must merge only the shards rather than
 * re-ingest a previous run's output as a "shard" (which claims every asset
 * twice, and refuses with a duplicate-digest error that names nothing
 * reuse-related).
 */
export function findShardManifests(dir: string, out: string): string[] {
  const mergedOut = resolve(join(resolve(out), RELEASE_MANIFEST_NAME));
  const found: string[] = [];
  const scan = (at: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      // HIDDEN entries are never shards. No upload lands a shard under a
      // dot-name, and this run's own staging directory is hidden precisely
      // so a SIGKILLed earlier run cannot leave a stale
      // `.merge-staging-<pid>/release-manifest.json` for the next run to
      // ingest as a fourth "shard" with a disagreeing digest.
      if (name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        if (depth > 0) scan(path, depth - 1);
        continue;
      }
      if (name !== RELEASE_MANIFEST_NAME) continue;
      if (resolve(path) === mergedOut) continue;
      found.push(path);
    }
  };
  scan(resolve(dir), 1);
  return found;
}

/** Read and parse each shard file, naming the file in any refusal. */
export function loadShardManifests(paths: readonly string[]): ShardManifest[] {
  return paths.map((path) => {
    const manifest = parseReleaseManifest(readFileSync(path, "utf8"));
    if (manifest === null) throw new Error(`${path} is not a valid release-manifest.json`);
    return { origin: path, manifest };
  });
}

/**
 * The binary asset names a merged manifest MUST carry, per component.
 *
 * Only the two CLI components: `server`/`node` releases are consumed by the
 * per-machine update paths that look a target up by exact name, so a missing
 * triple is a real dead end there. Desktop components publish manifests too
 * (spec 2026-09-15 §3.2) but nothing per-platform reads their `assets` map —
 * the apps update through `latest.json` — so a completeness rule would refuse
 * legitimate cuts for no consumer's sake.
 */
function requiredAssets(manifest: ReleaseManifest): string[] | null {
  if (manifest.component === "cli-node") return NODE_TARGETS.map((t) => releaseAssetNames("cli-node", t).binary);
  if (manifest.component === "cli-server") return SERVER_TARGETS.map((t) => releaseAssetNames("cli-server", t).binary);
  return null;
}

/**
 * Merge parsed shard manifests into one. Pure so a test can merge two shards
 * on a temp dir without a CLI or a key.
 *
 * @throws on any disagreement (see the module header for the list)
 */
export function mergeReleaseManifests(shards: readonly ShardManifest[]): ReleaseManifest {
  if (shards.length === 0) throw new Error("no shard manifests to merge");
  const first = shards[0]?.manifest;
  if (first === undefined) throw new Error("no shard manifests to merge");
  for (const shard of shards) {
    for (const field of ["component", "version", "nodeProtocol", "minAgentVersion", "commit"] as const) {
      if (shard.manifest[field] !== first[field]) {
        throw new Error(
          `shards disagree on ${field}: ${first[field]} (${shards[0]?.origin}) vs ${shard.manifest[field]} (${shard.origin})`,
        );
      }
    }
  }
  const assets: Record<string, string> = {};
  for (const shard of shards) {
    for (const [name, digest] of Object.entries(shard.manifest.assets)) {
      const prior = assets[name];
      if (prior !== undefined && prior !== digest) {
        throw new Error(`asset "${name}" has two digests across shards (${prior} vs ${digest})`);
      }
      assets[name] = digest;
    }
  }
  const merged: ReleaseManifest = { ...first, assets };
  const required = requiredAssets(merged);
  if (required !== null) {
    const missing = required.filter((name) => !(name in assets));
    if (missing.length > 0) {
      throw new Error(
        `the merged ${merged.component} manifest names no asset for: ${missing.join(", ")} — a shard built nothing or its upload was pruned`,
      );
    }
  }
  return merged;
}

async function main(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const dir = positional[0];
  if (dir === undefined) {
    console.error("usage: bun scripts/merge-release-manifest.ts <dir> [--out <dir>]");
    process.exit(1);
  }
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const from = resolve(dir);
  if (!existsSync(from)) throw new Error(`${from} does not exist`);

  const destDir = resolve(out ?? from);
  // Always exclude the destination's own file, even when it IS `from`: the
  // scan runs before the write, so that file can only ever be a previous
  // run's merged output — never a shard.
  const paths = findShardManifests(from, destDir);
  if (paths.length === 0) throw new Error(`no ${RELEASE_MANIFEST_NAME} under ${from}`);
  const merged = mergeReleaseManifests(loadShardManifests(paths));

  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, RELEASE_MANIFEST_NAME);
  // STAGE inside `destDir`, sign the staged pair, and `rename()` BOTH into
  // place only once the signature exists — the repo's atomic-publish idiom
  // (temp file + rename, the same one `publishArtifacts` uses per file),
  // lifted from one file to the pair because a manifest without its sig, or
  // the reverse, is the same half-state. The order this replaces wrote the
  // DESTINATION first and rm-synced it on refusal, so a re-run without
  // `TAURI_SIGNING_PRIVATE_KEY` in a reused directory deleted the previous
  // run's valid merged pair (review 2026-09-17): the refusal removed the
  // thing it refused to replace, not its own bytes. The staging directory is
  // inside `destDir` on purpose — rename is only atomic within one
  // filesystem — and its name cannot collide with a scan hit, because the
  // scan looks for `release-manifest.json` at the top level or one directory
  // deep and has ALREADY run by this point.
  const staging = join(destDir, `.merge-staging-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  try {
    const staged = join(staging, RELEASE_MANIFEST_NAME);
    // Write the merged bytes FIRST, then sign them by RE-READING the file —
    // `signPublishedReleaseManifest` signs the exact published bytes, which
    // is the rule the whole design rests on (§3). The bytes rename() moves
    // are the bytes that were read, so the armor covers exactly what ships.
    writeFileSync(staged, `${JSON.stringify(merged, null, 2)}\n`);
    const signed = await signPublishedReleaseManifest(staging, merged);
    if (signed !== "signed") {
      throw new Error(
        "TAURI_SIGNING_PRIVATE_KEY is not set — this script runs only in the publish job, whose shards already refused that absence; publishing an unsigned merged manifest would name a release no plane will offer for update",
      );
    }
    renameSync(staged, dest);
    renameSync(join(staging, RELEASE_MANIFEST_SIG_NAME), join(destDir, RELEASE_MANIFEST_SIG_NAME));
  } finally {
    // The temps only — the destination is touched by nothing until both
    // renames above have run.
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`merged ${paths.length} shard manifest(s) → ${dest} (+ ${RELEASE_MANIFEST_NAME}.sig), signed`);
  for (const name of Object.keys(merged.assets).sort()) console.log(`  ${name}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
