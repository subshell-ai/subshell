/**
 * The publish job's manifest merge (spec 2026-09-17 §7).
 *
 * The failure this pins is invisible everywhere it happens: each CI shard
 * writes its own `release-manifest.json` and its `assets` map names only its
 * own artifact, and softprops uploads by basename — so without the merge, the
 * last shard wins and the published signed release offers one platform while
 * refusing every machine on the others, by name, forever. The refusals here
 * are the shapes of that accident: a missing triple, two digests for one
 * asset, shards that disagree on what release they are in.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_TARGETS, SERVER_TARGETS } from "../../packages/subshell-protocol/src/paths.js";
import {
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  releaseAssetNames,
} from "../../packages/subshell-protocol/src/releases.js";
import {
  findShardManifests,
  loadShardManifests,
  mergeReleaseManifests,
  type ShardManifest,
} from "../merge-release-manifest.js";

const digestFor = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);

/** One shard manifest for `component`, naming exactly `assets`. */
function shard(component: "node" | "server" | "desktop-server", assets: Record<string, string>): ShardManifest {
  return {
    origin: `shard/${component}`,
    manifest: {
      component,
      version: "9.9.9",
      nodeProtocol: 12,
      minAgentVersion: "0.11.0",
      commit: "0".repeat(40),
      assets,
    },
  };
}

describe("mergeReleaseManifests", () => {
  it("unions the per-shard assets of a complete node cut", () => {
    const shards = NODE_TARGETS.map((t, i) =>
      shard("node", { [releaseAssetNames("node", t).binary]: digestFor(i + 1) }),
    );
    const merged = mergeReleaseManifests(shards);
    expect(Object.keys(merged.assets).sort()).toEqual(
      NODE_TARGETS.map((t) => releaseAssetNames("node", t).binary).sort(),
    );
    expect(merged.component).toBe("node");
    expect(merged.version).toBe("9.9.9");
  });

  it("refuses a shard set missing a platform — a dead-end machine is not a full cut", () => {
    const shards = NODE_TARGETS.slice(0, 2).map((t, i) =>
      shard("node", { [releaseAssetNames("node", t).binary]: digestFor(i + 1) }),
    );
    const missing = releaseAssetNames("node", NODE_TARGETS[2]!).binary;
    expect(() => mergeReleaseManifests(shards)).toThrow(new RegExp(`names no asset for: .*${missing}`));
  });

  it("refuses two shards giving one asset two digests", () => {
    const name = releaseAssetNames("server", "linux-x64").binary;
    expect(() =>
      mergeReleaseManifests([
        shard("server", { [name]: digestFor(1) }),
        shard("server", { [name]: digestFor(2) }),
        ...SERVER_TARGETS.slice(1).map((t) =>
          shard("server", { [releaseAssetNames("server", t).binary]: digestFor(9) }),
        ),
      ]),
    ).toThrow(/two digests across shards/);
  });

  it("refuses shards that disagree on the release itself, naming the field", () => {
    const a = shard("node", { [releaseAssetNames("node", "linux-x64").binary]: digestFor(1) });
    const b = { ...a, origin: "other", manifest: { ...a.manifest, version: "9.9.8" } };
    expect(() => mergeReleaseManifests([a, b])).toThrow(/disagree on version/);
  });

  it("does NOT impose the triple set on desktop components — nothing reads their assets", () => {
    const merged = mergeReleaseManifests([shard("desktop-server", { "x.dmg": digestFor(1) })]);
    expect(merged.assets).toEqual({ "x.dmg": digestFor(1) });
  });
});

describe("findShardManifests / loadShardManifests", () => {
  it("finds per-shard copies one directory deep and excludes the merged output", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-manifest-"));
    try {
      const out = join(root, "manifest");
      for (const t of NODE_TARGETS) {
        mkdirSync(join(root, `node-${t}`), { recursive: true });
        writeFileSync(
          join(root, `node-${t}`, RELEASE_MANIFEST_NAME),
          JSON.stringify(shard("node", { [releaseAssetNames("node", t).binary]: digestFor(1) }).manifest),
        );
      }
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, RELEASE_MANIFEST_NAME), "{}"); // would fail to PARSE if picked up
      const paths = findShardManifests(root, out);
      expect(paths.length).toBe(3);
      expect(paths.every((p) => p.includes("node-linux") || p.includes("node-darwin"))).toBe(true);
      // And it round-trips: exactly the three shard files parse.
      expect(loadShardManifests(paths).length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to load a file that is not a manifest, naming it", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-manifest-bad-"));
    try {
      const path = join(root, RELEASE_MANIFEST_NAME);
      writeFileSync(path, "{ not json");
      expect(() => loadShardManifests([path])).toThrow(/not a valid release-manifest/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the fixture of a real merge parses end to end", () => {
    const shards = NODE_TARGETS.map((t, i) =>
      shard("node", { [releaseAssetNames("node", t).binary]: digestFor(i + 1) }),
    );
    const parsed = parseReleaseManifest(JSON.stringify(mergeReleaseManifests(shards)));
    expect(Object.keys(parsed?.assets ?? {}).length).toBe(3);
  });
});

describe("merge-release-manifest CLI", () => {
  it("refuses to produce an unsigned merged manifest — the publish job always has the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "merge-manifest-cli-"));
    try {
      // A COMPLETE triple set, so the merge itself succeeds and the refusal
      // that fires is the missing key — proving the order: nothing reaches
      // the signing step that a merge would have rejected, and nothing
      // unsigned survives it.
      NODE_TARGETS.forEach((t, i) => {
        const shardDir = join(root, `node-${t}`);
        mkdirSync(shardDir, { recursive: true });
        writeFileSync(
          join(shardDir, RELEASE_MANIFEST_NAME),
          JSON.stringify(shard("node", { [releaseAssetNames("node", t).binary]: digestFor(i + 1) }).manifest),
        );
      });
      const proc = Bun.spawn(["bun", "scripts/merge-release-manifest.ts", root, "--out", join(root, "manifest")], {
        cwd: new URL("../../", import.meta.url).pathname,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(err).toContain("TAURI_SIGNING_PRIVATE_KEY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
