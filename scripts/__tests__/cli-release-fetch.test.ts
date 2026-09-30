import { describe, expect, test } from "bun:test";
import { apiHeaders, releaseTag, releaseTagUrl } from "../cli-release-fetch";

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
    // A CLI release carries 4×(binary + .sha256) + manifest + sig: over the
    // API's default 30-asset page the tail would silently "not exist".
    expect(releaseTagUrl("cli-node", "1.0.0")).toContain("per_page=100");
  });

  test("requests are authenticated and versioned; downloads ask for octet-stream", () => {
    const json = apiHeaders("tok");
    expect(json.Authorization).toBe("Bearer tok");
    expect(json.Accept).toBe("application/vnd.github+json");
    expect(json["User-Agent"]).toBe("subshell-release-fetch");
    expect(apiHeaders("tok", true).Accept).toBe("application/octet-stream");
  });
});
