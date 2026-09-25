import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  checkReleases,
  desktopAssetsProbe,
  desktopBundleNames,
  parseLsRemote,
  SCHEMA_VERSION,
  verifiedReleaseAssets,
  writeReleases,
} from "../site-releases";

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
  test("a failing runner exits non-zero in BOTH modes and leaves the output file untouched", async () => {
    // Seam shape: each mode takes the git runner and its output path, so the
    // failed-spawn path (the review's finding — empty stdout would otherwise
    // mean "no tags" and clobber or falsely flag the manifest) is testable
    // without network, and against a temp file rather than the real
    // releases.json.
    const dir = mkdtempSync(join(tmpdir(), "site-releases-"));
    const out = join(dir, "releases.json");
    writeFileSync(out, "SENTINEL\n");
    const failing = () => ({ exitCode: 128, stdout: new Uint8Array() });
    expect(await writeReleases(failing, out)).toBe(1);
    expect(checkReleases(failing, out)).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("SENTINEL\n");
    rmSync(dir, { recursive: true });
  });
});

// The fixture trio from the signature suite: real published bytes, real
// armor, and a second pubkey for the wrong-key refusal. Nothing here invents
// crypto — it reuses what already proves `verifyReleaseManifest`.
const FIX = join(import.meta.dir, "../../packages/subshell-protocol/src/__tests__/fixtures/release-signature");

describe("verifiedReleaseAssets — the signed-manifest rule at the site's door", () => {
  const manifest = readFileSync(join(FIX, "release-manifest.json"), "utf8");
  const sig = readFileSync(join(FIX, "release-manifest.sig"), "utf8");
  const pubkey = readFileSync(join(FIX, "publisher-pubkey.txt"), "utf8");
  const otherPubkey = readFileSync(join(FIX, "other-pubkey.txt"), "utf8");

  const servingFixture = async (url: string): Promise<string | null> => {
    if (url.endsWith("/release-manifest.json")) return manifest;
    if (url.endsWith("/release-manifest.json.sig")) return sig;
    return null;
  };

  test("the fixture trio verifies and its asset names come out sorted", async () => {
    const names = await verifiedReleaseAssets("cli-node", "9.9.9", servingFixture, pubkey);
    expect(names).toEqual([
      "subshell-node-cli-darwin-arm64",
      "subshell-node-cli-linux-arm64",
      "subshell-node-cli-linux-x64",
    ]);
  });

  test("a foreign pubkey refuses — replayed bytes from another publisher are no truth", async () => {
    expect(await verifiedReleaseAssets("cli-node", "9.9.9", servingFixture, otherPubkey)).toBeNull();
  });

  test("the payload must name the release asked for", async () => {
    // The fixture's manifest says cli-node 9.9.9; asking for 9.9.8 (or a
    // different component) must refuse, not borrow a nearby signature.
    expect(await verifiedReleaseAssets("cli-node", "9.9.8", servingFixture, pubkey)).toBeNull();
    expect(await verifiedReleaseAssets("cli-server", "9.9.9", servingFixture, pubkey)).toBeNull();
  });

  test("a missing sig, a missing manifest, and a throwing fetch all answer null", async () => {
    const noSig = async (url: string) => (url.endsWith("/release-manifest.json") ? manifest : null);
    const noManifest = async (url: string) => (url.endsWith("/release-manifest.json.sig") ? sig : null);
    const throwing = async () => {
      throw new Error("ENETDOWN");
    };
    expect(await verifiedReleaseAssets("cli-node", "9.9.9", noSig, pubkey)).toBeNull();
    expect(await verifiedReleaseAssets("cli-node", "9.9.9", noManifest, pubkey)).toBeNull();
    expect(await verifiedReleaseAssets("cli-node", "9.9.9", throwing, pubkey)).toBeNull();
  });
});

describe("desktopAssetsProbe — the default seam keeps NULL meaning 'could not ask'", () => {
  const manifest = readFileSync(join(FIX, "release-manifest.json"), "utf8");
  const sig = readFileSync(join(FIX, "release-manifest.sig"), "utf8");
  const pubkey = readFileSync(join(FIX, "publisher-pubkey.txt"), "utf8");
  const otherPubkey = readFileSync(join(FIX, "other-pubkey.txt"), "utf8");
  const servingFixture = async (url: string): Promise<string | null> => {
    if (url.endsWith("/release-manifest.json")) return manifest;
    if (url.endsWith("/release-manifest.json.sig")) return sig;
    return null;
  };

  test("an absent/offline release answers null, NOT [] (writeReleases omits the field)", async () => {
    // The wave's own bug: `?? []` collapsed "the probe could not ask" into
    // "the release ships no bundles". The site renders the same either way,
    // but the committed file's contract (and its header comment) is absence.
    expect(await desktopAssetsProbe("desktop-server", "1.2.3", async () => null, pubkey)).toBeNull();
  });

  test("a bad signature also answers null", async () => {
    expect(await desktopAssetsProbe("cli-node", "9.9.9", servingFixture, otherPubkey)).toBeNull();
  });

  test("verified with nothing renderable answers [] (the only meaning left)", async () => {
    // The fixture release is a CLI one: verified, and no .dmg/.deb among its
    // assets. [] now says exactly that, never "unknown".
    expect(await desktopAssetsProbe("cli-node", "9.9.9", servingFixture, pubkey)).toEqual([]);
  });
});

describe("desktopBundleNames", () => {
  test("keeps exactly the files the site could put behind a button", () => {
    expect(
      desktopBundleNames([
        "Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg",
        "Subshell-Server-Desktop-1.2.3-darwin-x64.dmg",
        "Subshell-Server-Desktop-1.2.3-darwin-arm64.app.tar.gz", // updater half, never a button
        "subshell-server-desktop_1.2.3_amd64.deb",
        "release-manifest.json",
      ]),
    ).toEqual([
      "Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg",
      "Subshell-Server-Desktop-1.2.3-darwin-x64.dmg",
      "subshell-server-desktop_1.2.3_amd64.deb",
    ]);
  });
});

describe("writeReleases desktopAssets attachment", () => {
  const desktopRunner = () => ({
    exitCode: 0,
    stdout: new TextEncoder().encode("abc123\trefs/tags/desktop-server-v1.2.3\n"),
  });

  test("the desktop entry carries the probed names; nothing else gains the field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "site-releases-assets-"));
    const out = join(dir, "releases.json");
    try {
      const dmg = "Subshell-Server-Desktop-1.2.3-darwin-x64.dmg";
      const code = await writeReleases(desktopRunner, out, async () => [dmg]);
      expect(code).toBe(0);
      const doc = JSON.parse(readFileSync(out, "utf8"));
      expect(doc.schemaVersion).toBe(1); // additive-optional: NOT a version bump
      expect(doc.components["desktop-server"].desktopAssets).toEqual([dmg]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a null probe (unverifiable release) omits the field rather than lying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "site-releases-null-"));
    const out = join(dir, "releases.json");
    try {
      const code = await writeReleases(desktopRunner, out, async () => null);
      expect(code).toBe(0);
      const doc = JSON.parse(readFileSync(out, "utf8"));
      expect("desktopAssets" in doc.components["desktop-server"]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("checkReleases ignores desktopAssets", () => {
  // --check re-derives the tag view offline; desktopAssets is a network probe
  // it cannot repeat deterministically, so it is stripped from BOTH sides
  // before the comparison — present, absent, or differing, it never drifts.
  const runner = () => ({
    exitCode: 0,
    stdout: new TextEncoder().encode("abc123\trefs/tags/desktop-server-v1.2.3\n"),
  });

  const committedWith = (extra: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "site-releases-check-"));
    const out = join(dir, "releases.json");
    writeFileSync(
      out,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "old",
        components: {
          "desktop-server": {
            version: "1.2.3",
            tag: "desktop-server-v1.2.3",
            url: "https://github.com/subshell-ai/subshell/releases/tag/desktop-server-v1.2.3",
            ...extra,
          },
        },
      }),
    );
    return { dir, out };
  };

  test("a committed desktopAssets field is not drift", () => {
    const { dir, out } = committedWith({ desktopAssets: ["Subshell-Server-Desktop-1.2.3-darwin-x64.dmg"] });
    try {
      expect(checkReleases(runner, out)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("its absence is not drift either", () => {
    const { dir, out } = committedWith({});
    try {
      expect(checkReleases(runner, out)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a genuinely stale version is still drift, field or no field", () => {
    const { dir, out } = committedWith({ desktopAssets: ["x.dmg"], version: "9.9.9" });
    try {
      expect(checkReleases(runner, out)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
