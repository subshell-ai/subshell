import { describe, expect, test } from "bun:test";
import { apiHeaders, fetchReleaseIndex, releaseIndexFrom, releaseTag, releaseTagUrl } from "../cli-release-fetch";

/**
 * The desktop bundles fetch the CLI's own release binary as their sidecar
 * (cut order, 2026-09-30), over the GitHub API because the linux shard's
 * container carries no gh. These pins are the URL shapes and the auth
 * posture; the transport itself is exercised by the desktop suites' injected
 * stubs, because a live fetch against a real release has nothing to pin
 * (any given version may be deleted) while these rules are forever.
 */

describe("cli-release-fetch", () => {
  test("the tag and URL name the component's release, prefix carrying the -v", () => {
    expect(releaseTag("cli-server", "1.7.0")).toBe("cli-server-v1.7.0");
    expect(releaseTag("cli-node", "1.4.0")).toBe("cli-node-v1.4.0");
    expect(releaseTagUrl("cli-server", "1.7.0")).toBe(
      "https://api.github.com/repos/subshell-ai/subshell/releases/tags/cli-server-v1.7.0?per_page=100",
    );
  });

  test("per_page governs the asset page too", () => {
    // A CLI release carries 4×(binary + .sha256) + manifest + sig today,
    // comfortably under the API's default 30-asset page; the pin is that an
    // asset added tomorrow must not silently "not exist" at the page tail.
    expect(releaseTagUrl("cli-node", "1.0.0")).toContain("per_page=100");
  });

  test("the index mapper: only a 200 indexes, and draft is read exactly", () => {
    expect(releaseIndexFrom(404, { assets: [{ name: "x", url: "u" }], draft: true })).toEqual({
      status: 404,
      assets: {},
      draft: true,
    });
    expect(releaseIndexFrom(200, { assets: [{ name: "x", url: "u" }] })).toEqual({
      status: 200,
      assets: { x: "u" },
      draft: false,
    });
    expect(releaseIndexFrom(200, { draft: true }).draft).toBe(true);
  });

  test("the index fetch refuses outright when GH_TOKEN is absent", async () => {
    // The throw must land BEFORE any request: the private repo answers 404
    // unauthenticated, and a silent 404 reads as "not published yet", which
    // is a lie about the cause. No fetch may even be attempted.
    const saved = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      await expect(fetchReleaseIndex("cli-server", "1.0.0")).rejects.toThrow(/GH_TOKEN is not set/);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
    }
  });

  test("requests are authenticated and versioned; downloads ask for octet-stream", () => {
    const json = apiHeaders("tok");
    expect(json.Authorization).toBe("Bearer tok");
    expect(json.Accept).toBe("application/vnd.github+json");
    expect(json["User-Agent"]).toBe("subshell-release-fetch");
    expect(apiHeaders("tok", true).Accept).toBe("application/octet-stream");
  });
});
