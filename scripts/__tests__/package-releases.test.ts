import { describe, expect, test } from "bun:test";
import { changelogSection, placeholderBody, publishedPackages, releaseBody } from "../package-releases";

describe("publishedPackages", () => {
  test("finds every non-private package under packages/, and nothing else", () => {
    const found = publishedPackages();
    const names = found.map((p) => p.name).sort();
    expect(names).toEqual([
      "@subshell-ai/plugin-api",
      "@subshell-ai/plugin-claude-code",
      "@subshell-ai/plugin-cloudflare-tunnel",
      "@subshell-ai/plugin-codex",
      "@subshell-ai/plugin-headscale",
      "@subshell-ai/plugin-hermes",
      "@subshell-ai/plugin-netbird",
      "@subshell-ai/plugin-opencode",
      "@subshell-ai/plugin-pi",
      "@subshell-ai/plugin-tailscale",
      "@subshell-ai/plugin-terminal",
    ]);
    // Private workspaces must never appear: a release for `@internal/*` would
    // be a tag for something nobody can install.
    for (const name of names) expect(name.startsWith("@subshell-ai/")).toBe(true);
  });

  test("builds the tag `changeset publish` actually pushes", () => {
    // Verified against the real remote: `refs/tags/@subshell-ai/plugin-api@1.0.0`.
    // The `@` is part of the tag, scope slash included — getting this shape
    // wrong means every release silently lands on a tag that does not exist.
    const api = publishedPackages().find((p) => p.name === "@subshell-ai/plugin-api");
    expect(api).toBeDefined();
    expect(api?.tag).toBe(`@subshell-ai/plugin-api@${api?.version}`);
    expect(api?.dir).toBe("packages/plugin-api");
  });
});

describe("changelogSection", () => {
  const changelog = [
    "# @subshell-ai/plugin-api",
    "",
    "## 2.0.0",
    "",
    "### Major Changes",
    "",
    "- the newest entry",
    "",
    "## 1.0.0",
    "",
    "### Minor Changes",
    "",
    "- the older entry",
    "",
  ].join("\n");

  test("slices one version, stopping at the next heading", () => {
    expect(changelogSection(changelog, "2.0.0")).toBe("### Major Changes\n\n- the newest entry");
    expect(changelogSection(changelog, "1.0.0")).toBe("### Minor Changes\n\n- the older entry");
  });

  test("takes the LAST section without running off the end", () => {
    // The oldest entry has no following `## `, so the slice has to end at the
    // file rather than returning nothing.
    expect(changelogSection(changelog, "1.0.0")).toContain("the older entry");
    expect(changelogSection(changelog, "1.0.0")).not.toContain("the newest entry");
  });

  test("answers null for a version with no section", () => {
    expect(changelogSection(changelog, "3.0.0")).toBeNull();
    expect(changelogSection("", "1.0.0")).toBeNull();
  });

  test("answers null for a heading with an empty body", () => {
    // A bare heading must not produce a release with a blank body — the
    // placeholder says more than nothing does.
    expect(changelogSection("## 1.0.0\n\n## 0.9.0\n\n- old\n", "1.0.0")).toBeNull();
  });

  test("matches the version exactly, never a prefix", () => {
    const versions = ["## 1.0.10", "", "- ten", "", "## 1.0.1", "", "- one", ""].join("\n");
    expect(changelogSection(versions, "1.0.1")).toBe("- one");
    expect(changelogSection(versions, "1.0.10")).toBe("- ten");
  });
});

describe("releaseBody", () => {
  test("falls back to the placeholder rather than publishing an empty body", () => {
    const pkg = { name: "@subshell-ai/plugin-api", version: "99.0.0", tag: "x", dir: "packages/plugin-api" };
    expect(releaseBody(pkg)).toBe(placeholderBody(pkg));
    expect(releaseBody(pkg)).toContain("99.0.0");
  });

  test("reads the real changelog for a version that has one", () => {
    const api = publishedPackages().find((p) => p.name === "@subshell-ai/plugin-api");
    expect(api).toBeDefined();
    if (api) expect(releaseBody(api)).not.toBe(placeholderBody(api));
  });
});
