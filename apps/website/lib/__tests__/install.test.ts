import { expect, test } from "bun:test";
import { detectIsMac, installCopy, macIntelAvailable, type ReleasesManifest } from "../install";

const m = {
  schemaVersion: 1,
  generatedAt: "x",
  components: {
    "cli-server": {
      version: "0.16.0",
      tag: "cli-server-v0.16.0",
      url: "https://x",
      installScript: "install-server.sh",
    },
    "desktop-server": { version: "0.16.0", tag: "desktop-server-v0.16.0", url: "https://ds" },
    "desktop-client": {
      version: "0.6.0",
      tag: "desktop-client-v0.6.0",
      url: "https://dc",
      installScript: "install-client.sh",
    },
  },
} as ReleasesManifest;

test("server+mac: dmg label, direct asset href, versioned filename, server curl", () => {
  const c = installCopy(m, "server", true);
  expect(c.downloadLabel).toBe("Download for macOS (.dmg)");
  // The button downloads the file, it does not tour the release page: tag and
  // filename are both known, so the release-page hop was never required.
  expect(c.downloadHref).toBe(
    "https://github.com/subshell-ai/subshell/releases/download/desktop-server-v0.16.0/Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg",
  );
  expect(c.altHref).toBe(
    "https://github.com/subshell-ai/subshell/releases/download/desktop-server-v0.16.0/subshell-server-desktop_0.16.0_amd64.deb",
  );
  expect(c.artifactFile).toBe("Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg");
  // The script comes from the product's own domain, not the git host: the
  // site serves its build-time copies of the root install-*.sh (spec
  // 2026-09-25 wave: install scripts from subshell.sh).
  expect(c.curlCommand).toBe("curl -fsSL https://subshell.sh/install-server.sh | bash");
});

test("client+linux: direct deb href, alt dmg href, client curl", () => {
  const c = installCopy(m, "client", false);
  expect(c.downloadLabel).toBe("Download for Linux (.deb)");
  expect(c.downloadHref).toBe(
    "https://github.com/subshell-ai/subshell/releases/download/desktop-client-v0.6.0/subshell-client-desktop_0.6.0_amd64.deb",
  );
  expect(c.altLabel).toBe("macOS (.dmg)");
  expect(c.altHref).toBe(
    "https://github.com/subshell-ai/subshell/releases/download/desktop-client-v0.6.0/Subshell-Client-Desktop-0.6.0-darwin-arm64.dmg",
  );
  expect(c.artifactFile).toBe("subshell-client-desktop_0.6.0_amd64.deb");
  expect(c.curlCommand).toBe("curl -fsSL https://subshell.sh/install-client.sh | bash");
});

test("client without installScript: download only, curl row gone (Review Focus 3)", () => {
  const stripped = {
    ...m,
    components: { ...m.components, "desktop-client": { version: "0.6.0", tag: "t", url: "u" } },
  } as ReleasesManifest;
  expect(installCopy(stripped, "client", true).curlCommand).toBeNull();
  expect(installCopy(stripped, "server", true).curlCommand).not.toBeNull();
});

test("headings name what each path delivers (operator note, 2026-09-25)", () => {
  expect(installCopy(m, "server", true).appHeading).toBe("Subshell Server desktop app");
  // Server's one-liner is the CLI; the client's installs the same desktop
  // app, so the curl heading is per kind by design, not an inconsistency.
  expect(installCopy(m, "server", true).curlHeading).toBe("or the CLI");
  expect(installCopy(m, "client", true).appHeading).toBe("Subshell Client desktop app");
  expect(installCopy(m, "client", true).curlHeading).toBe("The same app, one command");
});

test("missing desktop entry: generic releases href, no filename, no crash (Review Focus 2)", () => {
  // The cli-server entry inlined as a literal, not `m.components[...]!`: the
  // non-null assertion is what this file's lint check flags.
  const cliServer = {
    version: "0.16.0",
    tag: "cli-server-v0.16.0",
    url: "https://x",
    installScript: "install-server.sh",
  };
  const partial = { ...m, components: { "cli-server": cliServer } } as ReleasesManifest;
  const c = installCopy(partial, "client", true);
  expect(c.downloadHref).toBe("https://github.com/subshell-ai/subshell/releases");
  expect(c.artifactFile).toBeNull();
  expect(c.curlCommand).toBeNull();
});

test("detectIsMac mirrors the concept's sniffing", () => {
  expect(detectIsMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel")).toBe(true);
  expect(detectIsMac("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64")).toBe(false);
});

// ── Intel Mac: the arch choice ──────────────────────────────────────────────
// Note the UA above: even an Intel Mac's own user-agent reads "Intel Mac OS
// X" and platform reads "MacIntel", so the browser cannot pick the arch —
// that is why the menu exists and why the default stays Apple silicon.

const withAssets = (assets: string[] | undefined) =>
  ({
    ...m,
    components: {
      ...m.components,
      "desktop-server": {
        version: "0.16.0",
        tag: "desktop-server-v0.16.0",
        url: "https://ds",
        ...(assets === undefined ? {} : { desktopAssets: assets }),
      },
    },
  }) as ReleasesManifest;

const bothMacs = withAssets([
  "Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg",
  "Subshell-Server-Desktop-0.16.0-darwin-x64.dmg",
  "subshell-server-desktop_0.16.0_amd64.deb",
]);
const armOnly = withAssets(["Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg"]);

test("macIntelAvailable reads the release's verified asset list, never the field's existence alone", () => {
  expect(macIntelAvailable(bothMacs, "server")).toBe(true);
  // Probed, and the answer was "no Intel bundle in this cut":
  expect(macIntelAvailable(armOnly, "server")).toBe(false);
  // No probe data at all (a pre-desktopAssets manifest): conservative no.
  expect(macIntelAvailable(m, "server")).toBe(false);
  // The predicate is per kind — Client's entry has no assets in these fixtures:
  expect(macIntelAvailable(bothMacs, "client")).toBe(false);
});

test("with Intel published, the selection drives label, href and the filename line", () => {
  const intel = installCopy(bothMacs, "server", true, "darwin-x64");
  expect(intel.downloadLabel).toBe("Download for Intel (.dmg)");
  expect(intel.downloadHref).toContain("Subshell-Server-Desktop-0.16.0-darwin-x64.dmg");
  expect(intel.artifactFile).toBe("Subshell-Server-Desktop-0.16.0-darwin-x64.dmg");
  const arm = installCopy(bothMacs, "server", true, "darwin-arm64");
  expect(arm.downloadLabel).toBe("Download for Apple silicon (.dmg)");
  expect(arm.artifactFile).toBe("Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg");
  // The Linux alternative is untouched by the choice:
  expect(intel.altLabel).toBe("Linux (.deb)");
  expect(intel.altHref).toContain("subshell-server-desktop_0.16.0_amd64.deb");
});

test("default selection is Apple silicon — the arch no browser can detect", () => {
  expect(installCopy(bothMacs, "server", true).downloadLabel).toBe("Download for Apple silicon (.dmg)");
});

// The label idiom (operator choice, 2026-09-25): the button matches the menu
// rows and the alt link, `Name (.ext)`, never `Name · .ext`.
test("without Intel, macOS copy names no arch: the plain button speaks the same way", () => {
  for (const manifest of [m, armOnly]) {
    expect(installCopy(manifest, "server", true).downloadLabel).toBe("Download for macOS (.dmg)");
  }
});

test("the Linux path ignores the arch parameter entirely", () => {
  expect(installCopy(bothMacs, "server", false, "darwin-x64").downloadLabel).toBe("Download for Linux (.deb)");
});
