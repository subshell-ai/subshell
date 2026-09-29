#!/usr/bin/env bun
// Verify staged release assets before they are baked into the Docker image
// (spec 2026-09-28 § 4). The rule is the product's own: the minisign signature
// over the manifest's exact bytes FIRST, then digests from the SIGNED assets
// map - never a .sha256 sidecar. Bad sig / bad digest / no manifest: refuse BY
// NAME, exit 1; the workflow pushes only on exit 0.
//
//   bun run scripts/docker-release-verify.ts <dir> <version>
//
// <dir> must hold release-manifest.json + .sig; either or both linux server
// binaries may be present (each per-arch CI job stages its own), and every
// present one is digest-checked.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_TARGETS, serverArtifactFileName } from "../packages/subshell-protocol/src/paths.js";
import { verifyReleaseManifest } from "../packages/subshell-protocol/src/release-signature.js";
import {
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_PUBKEY,
} from "../packages/subshell-protocol/src/releases.js";

/**
 * The linux server binaries present in `dir`, named from the protocol's own
 * naming (`serverArtifactFileName` over the linux half of `SERVER_TARGETS`),
 * so a rename in paths.ts can never leave this script looking for a file the
 * pipeline no longer publishes.
 */
export function stagedBinaryNames(dir: string): string[] {
  return SERVER_TARGETS.filter((target) => target.startsWith("linux-"))
    .map((target) => serverArtifactFileName(target))
    .filter((n) => existsSync(join(dir, n)));
}

/**
 * Refusal lines for every staged binary whose digest is not the one the
 * SIGNED assets map names; empty means everything staged matches (and each
 * match is logged as it checks). `assets` is the verified manifest's map, so
 * a name absent from it is a refusal, not a skip.
 *
 * Exported so `scripts/__tests__/docker-release-verify.test.ts` can drive the
 * digest layer directly: reaching it through `main` end-to-end would need a
 * manifest signed by the real publisher key, whose secret exists only in the
 * release shards' CI secrets.
 */
export function digestRefusals(dir: string, assets: Record<string, string>): string[] {
  const refusals: string[] = [];
  for (const name of stagedBinaryNames(dir)) {
    const expected = assets[name];
    const actual = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    if (expected === undefined || expected !== actual) {
      refusals.push(`${name} digest ${actual} is not the signed ${expected ?? "(absent from the manifest)"}`);
    } else {
      console.log(`verified ${name} ${actual.slice(0, 12)}...`);
    }
  }
  return refusals;
}

async function main(): Promise<void> {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error("usage: docker-release-verify.ts <dir> <version>");
    process.exit(1);
  }

  const manifestPath = join(dir, RELEASE_MANIFEST_NAME);
  const sigPath = join(dir, RELEASE_MANIFEST_SIG_NAME);
  if (!existsSync(manifestPath) || !existsSync(sigPath)) {
    console.error(
      `refused: ${dir} holds no ${RELEASE_MANIFEST_NAME} (+ .sig); nothing is trusted without the signature`,
    );
    process.exit(1);
  }

  const verdict = await verifyReleaseManifest(
    readFileSync(manifestPath),
    readFileSync(sigPath, "utf8"),
    RELEASE_PUBKEY,
    { component: "cli-server", version },
  );
  if (!verdict.ok) {
    console.error(`refused: ${verdict.reason}`);
    process.exit(1);
  }

  const names = stagedBinaryNames(dir);
  if (names.length === 0) {
    console.error("refused: the staged dir holds no linux server binary to bake");
    process.exit(1);
  }
  const refusals = digestRefusals(dir, verdict.manifest.assets);
  if (refusals.length > 0) {
    for (const line of refusals) console.error(`refused: ${line}`);
    process.exit(1);
  }
  console.log(`verified: release-manifest.json for cli-server ${version} + ${names.length} linux binary file(s)`);
}

if (import.meta.main) await main();
