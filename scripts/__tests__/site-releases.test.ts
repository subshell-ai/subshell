import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, checkReleases, parseLsRemote, SCHEMA_VERSION, writeReleases } from "../site-releases";

const SCRIPTS = { "cli-server": "install-server.sh", "desktop-client": "install-client.sh" } as const;

describe("parseLsRemote", () => {
  test("extracts plain tag names and drops peeled refs and the refs/tags/ prefix", () => {
    const out = [
      "aaa refs/tags/cli-server-v0.16.0",
      "bbb refs/tags/cli-server-v0.16.0^{}",
      "ccc refs/tags/docs-v0.3.2",
      "ddd refs/heads/main",
    ].join("\n");
    expect(parseLsRemote(out)).toEqual(["cli-server-v0.16.0", "docs-v0.3.2"]);
  });
});

describe("buildManifest", () => {
  const tags = [
    "cli-server-v0.9.0",
    "cli-server-v0.16.0",
    "cli-server-v0.10.0",
    "cli-node-v0.16.0",
    "desktop-server-v0.16.0",
    "desktop-client-v0.6.0",
    "docs-v0.3.2",
    "website-v0.1.0",
    "@subshell-ai/plugin-api@0.2.0",
  ];

  test("picks newest PER COMPONENT by semver, ignores other refs", () => {
    const m = buildManifest(tags, { generatedAt: "2026-09-23T00:00:00.000Z", installScripts: SCRIPTS });
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.components["cli-server"]?.version).toBe("0.16.0"); // not 0.9.0, not by string order
    expect(m.components["cli-node"]?.tag).toBe("cli-node-v0.16.0");
    expect(m.components["desktop-client"]?.version).toBe("0.6.0");
    expect(Object.keys(m.components).sort()).toEqual(["cli-node", "cli-server", "desktop-client", "desktop-server"]);
  });

  test("urls are the release-tag pages built from SUBSHELL_REPO_SLUG", () => {
    const m = buildManifest(tags, { generatedAt: "x", installScripts: {} });
    expect(m.components["cli-server"]?.url).toBe(
      "https://github.com/subshell-ai/subshell/releases/tag/cli-server-v0.16.0",
    );
  });

  test("installScript appears only when the caller says the script exists", () => {
    const m = buildManifest(tags, { generatedAt: "x", installScripts: SCRIPTS });
    expect(m.components["cli-server"]?.installScript).toBe("install-server.sh");
    expect(m.components["desktop-client"]?.installScript).toBe("install-client.sh");
    expect(m.components["cli-node"]?.installScript).toBeUndefined();
  });

  test("a component with no tags is simply absent, not null", () => {
    const m = buildManifest(["cli-server-v1.0.0"], { generatedAt: "x", installScripts: {} });
    expect("desktop-client" in m.components).toBe(false);
    expect(m.components["cli-server"]?.version).toBe("1.0.0");
  });

  test("prerelease-suffixed tags are refused (three-numeric-parts rule)", () => {
    const m = buildManifest(["cli-server-v1.0.0-rc1", "cli-server-v0.9.9"], {
      generatedAt: "x",
      installScripts: {},
    });
    expect(m.components["cli-server"]?.version).toBe("0.9.9");
  });
});

describe("ls-remote failure", () => {
  test("a failing runner exits non-zero in BOTH modes and leaves the output file untouched", () => {
    // Seam shape: each mode takes the git runner and its output path, so the
    // failed-spawn path (the review's finding — empty stdout would otherwise
    // mean "no tags" and clobber or falsely flag the manifest) is testable
    // without network, and against a temp file rather than the real
    // releases.json.
    const dir = mkdtempSync(join(tmpdir(), "site-releases-"));
    const out = join(dir, "releases.json");
    writeFileSync(out, "SENTINEL\n");
    const failing = () => ({ exitCode: 128, stdout: new Uint8Array() });
    expect(writeReleases(failing, out)).toBe(1);
    expect(checkReleases(failing, out)).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("SENTINEL\n");
    rmSync(dir, { recursive: true });
  });
});
