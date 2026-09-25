/**
 * The desktop updater's manifest: the names, the shard document, and the merge
 * (spec 2026-09-15 § 8).
 *
 * Every failure this covers has the SAME symptom on a user's machine — an
 * installed app that reports "no updates" forever — and none of them is an
 * error anywhere in the pipeline. A wrong platform key, a signature that did
 * not travel, a version that disagrees between shards: the plugin simply finds
 * nothing it can use and says so quietly. That is why these are refusals at
 * build time rather than checks at runtime.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
} from "../../packages/subshell-protocol/src/paths.js";
import { findShardManifests, mergeFrom } from "../merge-updater-manifests.js";
import {
  assetDownloadUrl,
  buildShardManifest,
  LATEST_MANIFEST_NAME,
  latestManifestName,
  mergeUpdaterManifests,
  parseShardManifest,
  updaterArtifactName,
  updaterPlatformKey,
} from "../updater-manifest.js";

const VERSION = "0.7.0";

function shard(target: string, product: string, tag: string, signature = "sig-bytes") {
  const bundle = desktopArtifactFileName(product, target, VERSION);
  return buildShardManifest({
    version: VERSION,
    tag,
    target,
    asset: updaterArtifactName(bundle, target),
    signature,
    publishedAt: "2026-09-15T12:00:00Z",
  });
}

describe("the platform key", () => {
  // The plugin matches on ITS spelling of the architecture, not this repo's.
  // A manifest keyed `darwin-arm64` parses, merges, uploads and then matches
  // nothing — so every installed Mac is told there is no update, forever, with
  // no error anywhere.
  it("is Tauri's spelling, not this repo's", () => {
    expect(updaterPlatformKey("darwin-arm64")).toBe("darwin-aarch64");
    expect(updaterPlatformKey("darwin-x64")).toBe("darwin-x86_64");
    expect(updaterPlatformKey("linux-x64")).toBe("linux-x86_64");
  });

  it("refuses a target it has no key for", () => {
    expect(() => updaterPlatformKey("linux-arm64")).toThrow("no updater platform key");
    expect(() => updaterPlatformKey("windows-x64")).toThrow();
  });

  // Every target this repo builds a desktop bundle for must have one. A target
  // added to DESKTOP_TARGETS without a key here would build, publish and then
  // be unreachable by the updater.
  it("exists for every desktop target", () => {
    for (const target of DESKTOP_TARGETS) expect(updaterPlatformKey(target)).toMatch(/^(darwin|linux)-/);
  });
});

describe("the updater artifact name", () => {
  // macOS: the plugin replaces an installed `.app` from a tarball; the DMG is
  // for humans. Linux: the `.deb` IS the update package, handed to dpkg.
  it("is a tarball beside the DMG, and the .deb itself", () => {
    const dmg = desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", VERSION);
    expect(updaterArtifactName(dmg, "darwin-arm64")).toBe(`Subshell-Server-Desktop-${VERSION}-darwin-arm64.app.tar.gz`);
    const deb = desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", VERSION);
    expect(updaterArtifactName(deb, "linux-x64")).toBe(deb);
  });

  // Derived from the published bundle name rather than re-spelled, so the
  // published-name rules hold by construction: space-free (these are download
  // URLs) and carrying the `Desktop` token that says which kind of artifact it
  // is, which is the rule `desktop-paths.test.ts` states for the whole set.
  it("stays space-free and keeps the Desktop token", () => {
    for (const product of [DESKTOP_SERVER_PRODUCT, DESKTOP_CLIENT_PRODUCT]) {
      for (const target of DESKTOP_TARGETS) {
        const name = updaterArtifactName(desktopArtifactFileName(product, target, VERSION), target);
        expect(name).not.toContain(" ");
        expect(name.toLowerCase()).toContain("desktop");
      }
    }
  });

  it("refuses a darwin bundle that is not a DMG", () => {
    expect(() => updaterArtifactName("something.zip", "darwin-arm64")).toThrow("expected a .dmg");
  });
});

describe("a shard manifest", () => {
  it("names the tag's own download URL and the release page", () => {
    const doc = shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0");
    expect(doc.version).toBe(VERSION);
    expect(doc.notes).toBe("https://github.com/subshell-ai/subshell/releases/tag/desktop-server-v0.7.0");
    expect(Object.keys(doc.platforms)).toEqual(["darwin-aarch64"]);
    expect(doc.platforms["darwin-aarch64"]?.url).toBe(
      `https://github.com/subshell-ai/subshell/releases/download/desktop-server-v0.7.0/Subshell-Server-Desktop-${VERSION}-darwin-arm64.app.tar.gz`,
    );
    expect(doc.platforms["darwin-aarch64"]?.signature).toBe("sig-bytes");
  });

  // An empty `.sig` is the failure that publishes silently: the manifest is
  // well-formed, the upload succeeds, and every installed app refuses the
  // update it describes — which reads as "there are no updates".
  it("refuses an empty signature", () => {
    expect(() =>
      buildShardManifest({ version: VERSION, tag: "desktop-server-v0.7.0", target: "linux-x64", asset: "x.deb", signature: "  " }),
    ).toThrow("signature");
  });

  // The file name a bundle is published under is chosen by this repo, so it
  // can contain characters a URL cannot carry raw. Nothing in the current set
  // does, which is exactly why the encoding has to be pinned rather than
  // observed.
  it("percent-encodes the asset name in the URL", () => {
    expect(assetDownloadUrl("t-v1", "a b.deb")).toBe(
      "https://github.com/subshell-ai/subshell/releases/download/t-v1/a%20b.deb",
    );
  });

  it("names the shard file by its triple", () => {
    expect(latestManifestName("darwin-arm64")).toBe("latest.darwin-arm64.json");
    expect(latestManifestName("linux-x64")).toBe("latest.linux-x64.json");
    expect(LATEST_MANIFEST_NAME).toBe("latest.json");
  });
});

describe("the merge", () => {
  it("joins every platform into one document", () => {
    const merged = mergeUpdaterManifests([
      shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0"),
      shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0"),
    ]);
    expect(merged.version).toBe(VERSION);
    expect(Object.keys(merged.platforms).sort()).toEqual(["darwin-aarch64", "linux-x86_64"]);
    expect(merged.pub_date).toBe("2026-09-15T12:00:00Z");
  });

  // The plugin compares the RUNNING app's version against the manifest's ONE
  // `version` field, so two shards built from different commits would have the
  // merged document telling at least one platform something untrue about what
  // it is being offered.
  it("refuses shards that disagree on the version", () => {
    const a = shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0");
    const b = { ...shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0"), version: "0.8.0" };
    expect(() => mergeUpdaterManifests([a, b])).toThrow("disagree on the version");
  });

  // A duplicate is a matrix bug, and picking one silently would publish an
  // arbitrary binary under a canonical name — the outcome `selectBundleOutput`
  // refuses for the same reason.
  it("refuses a platform claimed twice", () => {
    const a = shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0");
    expect(() => mergeUpdaterManifests([a, a])).toThrow("both claim the platform");
  });

  it("refuses an empty set", () => {
    expect(() => mergeUpdaterManifests([])).toThrow("no latest");
  });

  /**
   * A PARTIAL manifest is the failure this module exists to prevent, and it is
   * the only one that publishes cleanly.
   *
   * One platform missing is not an error anywhere: the document is valid, the
   * release uploads, and every installed app on the other platform asks for
   * updates forever and is told there are none. Half the fleet works
   * perfectly, which is precisely how it would go unnoticed. The publish job's
   * `needs: [plan, build]` already fails the release when a shard dies, so
   * this is the second lock on that door — and the one that is in the file
   * somebody reads when it happens anyway.
   */
  it("refuses a merged set that is missing an expected platform", () => {
    const only = [shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")];
    expect(() => mergeUpdaterManifests(only, ["darwin-aarch64", "linux-x86_64"])).toThrow(/missing linux-x86_64/);
    // …and says what the consequence would have been, because "missing" alone
    // reads as a detail rather than as a reason to stop a release.
    expect(() => mergeUpdaterManifests(only, ["darwin-aarch64", "linux-x86_64"])).toThrow(/no updates/);
    // With nothing expected it still merges — the pure function stays usable
    // by a caller that means to merge one.
    expect(Object.keys(mergeUpdaterManifests(only).platforms)).toEqual(["darwin-aarch64"]);
  });
});

describe("parsing a shard file", () => {
  it("accepts what buildShardManifest writes", () => {
    const doc = shard("linux-x64", DESKTOP_CLIENT_PRODUCT, "desktop-client-v0.7.0");
    expect(parseShardManifest(JSON.stringify(doc), "latest.linux-x64.json")).toEqual(doc);
  });

  it("names the file in every refusal", () => {
    expect(() => parseShardManifest("not json", "latest.x.json")).toThrow("latest.x.json");
    expect(() => parseShardManifest("{}", "latest.x.json")).toThrow("no version");
    expect(() => parseShardManifest(JSON.stringify({ version: "1", notes: "n", pub_date: "p" }), "f")).toThrow(
      "no platforms",
    );
    const noSig = { version: "1", notes: "n", pub_date: "p", platforms: { "linux-x86_64": { url: "https://x" } } };
    expect(() => parseShardManifest(JSON.stringify(noSig), "f")).toThrow("no signature");
    const httpUrl = {
      version: "1",
      notes: "n",
      pub_date: "p",
      platforms: { "linux-x86_64": { signature: "s", url: "http://x" } },
    };
    expect(() => parseShardManifest(JSON.stringify(httpUrl), "f")).toThrow("no https url");
  });
});

describe("finding the shards on disk", () => {
  it("looks one directory down, where download-artifact puts them", () => {
    const root = mkdtempSync(join(tmpdir(), "subshell-updater-"));
    try {
      mkdirSync(join(root, "desktop-server-darwin-arm64"));
      mkdirSync(join(root, "desktop-server-linux-x64"));
      mkdirSync(join(root, "desktop-server-darwin-x64"));
      writeFileSync(
        join(root, "desktop-server-darwin-arm64", "latest.darwin-arm64.json"),
        JSON.stringify(shard("darwin-arm64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      writeFileSync(
        join(root, "desktop-server-darwin-x64", "latest.darwin-x64.json"),
        JSON.stringify(shard("darwin-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      writeFileSync(
        join(root, "desktop-server-linux-x64", "latest.linux-x64.json"),
        JSON.stringify(shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      // Not a shard manifest, and not a mistake either — a release directory
      // is full of other files.
      writeFileSync(join(root, "desktop-server-linux-x64", "release-manifest.json"), "{}");
      const found = findShardManifests(root);
      expect(found).toHaveLength(3);
      const merged = mergeFrom(found);
      expect(Object.keys(merged.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Re-running over a directory that already holds the output would otherwise
  // claim every platform twice and refuse — a confusing way to discover that
  // the directory was reused.
  it("skips a latest.json left by a previous run", () => {
    const root = mkdtempSync(join(tmpdir(), "subshell-updater-"));
    try {
      writeFileSync(
        join(root, "latest.linux-x64.json"),
        JSON.stringify(shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      writeFileSync(
        join(root, LATEST_MANIFEST_NAME),
        JSON.stringify(shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      expect(findShardManifests(root).map((p) => p.split("/").pop())).toEqual(["latest.linux-x64.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The CLI half of the rule above: the script that CI runs expects every
  // DESKTOP_TARGETS platform, so a directory holding one shard stops the
  // release rather than publishing a manifest half the fleet cannot use.
  it("refuses a directory that holds only one platform's shard", () => {
    const root = mkdtempSync(join(tmpdir(), "subshell-updater-"));
    try {
      writeFileSync(
        join(root, "latest.linux-x64.json"),
        JSON.stringify(shard("linux-x64", DESKTOP_SERVER_PRODUCT, "desktop-server-v0.7.0")),
      );
      expect(() => mergeFrom(findShardManifests(root))).toThrow(/missing darwin-aarch64/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
