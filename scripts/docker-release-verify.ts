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
import { verifyReleaseManifest } from "../packages/subshell-protocol/src/release-signature.js";
import {
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_PUBKEY,
} from "../packages/subshell-protocol/src/releases.js";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) {
  console.error("usage: docker-release-verify.ts <dir> <version>");
  process.exit(1);
}

const manifestPath = join(dir, RELEASE_MANIFEST_NAME);
const sigPath = join(dir, RELEASE_MANIFEST_SIG_NAME);
if (!existsSync(manifestPath) || !existsSync(sigPath)) {
  console.error(`refused: ${dir} holds no ${RELEASE_MANIFEST_NAME} (+ .sig); nothing is trusted without the signature`);
  process.exit(1);
}

const verdict = await verifyReleaseManifest(readFileSync(manifestPath), readFileSync(sigPath, "utf8"), RELEASE_PUBKEY, {
  component: "cli-server",
  version,
});
if (!verdict.ok) {
  console.error(`refused: ${verdict.reason}`);
  process.exit(1);
}

const names = ["subshell-server-cli-linux-x64", "subshell-server-cli-linux-arm64"].filter((n) =>
  existsSync(join(dir, n)),
);
if (names.length === 0) {
  console.error("refused: the staged dir holds no linux server binary to bake");
  process.exit(1);
}
for (const name of names) {
  const expected = verdict.manifest.assets[name];
  const actual = createHash("sha256")
    .update(readFileSync(join(dir, name)))
    .digest("hex");
  if (expected === undefined || expected !== actual) {
    console.error(`refused: ${name} digest ${actual} is not the signed ${expected ?? "(absent from the manifest)"}`);
    process.exit(1);
  }
  console.log(`verified ${name} ${actual.slice(0, 12)}...`);
}
console.log(`verified: release-manifest.json for cli-server ${version} + ${names.length} linux binary file(s)`);
