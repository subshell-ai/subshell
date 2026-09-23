import { expect, test } from "bun:test";
import { detectIsMac, installCopy, type ReleasesManifest } from "../install";

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

test("server+mac: dmg label, tag URL href, versioned filename, server curl", () => {
  const c = installCopy(m, "server", true);
  expect(c.downloadLabel).toBe("Download for macOS · .dmg");
  expect(c.downloadHref).toBe("https://ds");
  expect(c.artifactFile).toBe("Subshell-Server-Desktop-0.16.0-darwin-arm64.dmg");
  expect(c.curlCommand).toBe(
    "curl -fsSL https://raw.githubusercontent.com/subshell-ai/subshell/main/install-server.sh | bash",
  );
});

test("client+linux: deb filename via desktopArtifactFileName, client curl", () => {
  const c = installCopy(m, "client", false);
  expect(c.downloadLabel).toBe("Download for Linux · .deb");
  expect(c.altLabel).toBe("macOS (.dmg)");
  expect(c.artifactFile).toBe("subshell-client-desktop_0.6.0_amd64.deb");
  expect(c.curlCommand).toBe(
    "curl -fsSL https://raw.githubusercontent.com/subshell-ai/subshell/main/install-client.sh | bash",
  );
});

test("client without installScript: download only, curl row gone (Review Focus 3)", () => {
  const stripped = {
    ...m,
    components: { ...m.components, "desktop-client": { version: "0.6.0", tag: "t", url: "u" } },
  } as ReleasesManifest;
  expect(installCopy(stripped, "client", true).curlCommand).toBeNull();
  expect(installCopy(stripped, "server", true).curlCommand).not.toBeNull();
});

test("missing desktop entry: generic releases href, no filename, no crash (Review Focus 2)", () => {
  const partial = { ...m, components: { "cli-server": m.components["cli-server"]! } } as ReleasesManifest;
  const c = installCopy(partial, "client", true);
  expect(c.downloadHref).toBe("https://github.com/subshell-ai/subshell/releases");
  expect(c.artifactFile).toBeNull();
  expect(c.curlCommand).toBeNull();
});

test("detectIsMac mirrors the concept's sniffing", () => {
  expect(detectIsMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel")).toBe(true);
  expect(detectIsMac("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64")).toBe(false);
});
