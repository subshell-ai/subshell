import { describe, expect, it } from "bun:test";
import {
  DEFAULT_NODE_RELEASE_API,
  newestNodeRelease,
  nodeReleaseAssetNames,
  parseNodeReleaseTag,
  parseSidecarDigest,
  SUBSHELL_REPO_SLUG,
} from "../node-release.js";

describe("parseNodeReleaseTag", () => {
  it("takes the version out of a node tag", () => {
    expect(parseNodeReleaseTag("node-v0.2.0")).toBe("0.2.0");
    expect(parseNodeReleaseTag("node-v10.20.30")).toBe("10.20.30");
  });

  it("ignores every other component's tags", () => {
    // The four apps share one Releases page, and so do the seven npm
    // packages. A prefix test that also matched `desktop-client-v…` would
    // hand a node a desktop bundle.
    for (const tag of [
      "server-v0.2.0",
      "desktop-server-v0.2.0",
      "desktop-client-v0.1.3",
      "@subshell-ai/plugin-api@1.0.0",
      "v0.2.0",
      "node-v",
    ]) {
      expect(parseNodeReleaseTag(tag), tag).toBeNull();
    }
  });

  it("refuses a prerelease or build-metadata suffix", () => {
    // The plane would otherwise hand a node a build the release pipeline does
    // not smoke the same way.
    expect(parseNodeReleaseTag("node-v1.0.0-rc.1")).toBeNull();
    expect(parseNodeReleaseTag("node-v1.0.0+build7")).toBeNull();
    expect(parseNodeReleaseTag("node-v1.0")).toBeNull();
  });
});

describe("newestNodeRelease", () => {
  it("picks by semver, not by the order given", () => {
    const tags = ["node-v0.2.0", "node-v0.10.0", "node-v0.9.0"];
    expect(newestNodeRelease(tags)).toEqual({ tag: "node-v0.10.0", version: "0.10.0" });
    expect(newestNodeRelease([...tags].reverse())).toEqual({ tag: "node-v0.10.0", version: "0.10.0" });
  });

  it("is not fooled by a re-cut publishing after a newer version", () => {
    // GitHub returns releases newest-FIRST by date. A date-ordered pick would
    // hand every new node a downgrade the day an old version is re-cut.
    expect(newestNodeRelease(["node-v0.1.9", "node-v0.3.0"])?.version).toBe("0.3.0");
  });

  it("answers null when the repository has no node release", () => {
    expect(newestNodeRelease([])).toBeNull();
    expect(newestNodeRelease(["server-v1.0.0", "desktop-client-v1.0.0"])).toBeNull();
  });
});

describe("nodeReleaseAssetNames", () => {
  it("names exactly what the release publishes", () => {
    // Verified against the real node-v0.2.0 release's asset list.
    expect(nodeReleaseAssetNames("darwin-arm64")).toEqual({
      binary: "subshell-node-cli-darwin-arm64",
      sidecar: "subshell-node-cli-darwin-arm64.sha256",
    });
  });
});

describe("parseSidecarDigest", () => {
  const digest = "84b7f6ab0d7fc1242440131aa86e26707b187860e94be68b83ef2698e93319e0";

  it("reads this repo's bare-digest sidecar", () => {
    expect(parseSidecarDigest(`${digest}\n`)).toBe(digest);
  });

  it("also reads `sha256sum` output, which a release could carry instead", () => {
    expect(parseSidecarDigest(`${digest}  subshell-node-cli-darwin-arm64\n`)).toBe(digest);
  });

  it("refuses anything that is not a digest", () => {
    // An HTML error page or a truncated download must never become the thing
    // a binary is verified against.
    expect(parseSidecarDigest("")).toBeNull();
    expect(parseSidecarDigest("<!doctype html>")).toBeNull();
    expect(parseSidecarDigest(digest.slice(0, 63))).toBeNull();
    expect(parseSidecarDigest(digest.toUpperCase())).toBeNull();
  });
});

describe("the release source", () => {
  it("reads the LIST endpoint, not /releases/latest", () => {
    // "Latest" is a property of the whole repository, and this one publishes
    // four apps plus a release per npm package — the newest release is very
    // often not a node one.
    expect(DEFAULT_NODE_RELEASE_API).toBe(`https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases`);
    expect(DEFAULT_NODE_RELEASE_API).not.toContain("/latest");
  });
});
