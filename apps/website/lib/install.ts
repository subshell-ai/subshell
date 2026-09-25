import { desktopArtifactFileName } from "@internal/subshell-protocol";
import type { ReleasesManifest } from "./releases";

export type { ReleasesManifest };

export type InstallKind = "server" | "client";

const REPO = "subshell-ai/subshell";

export function detectIsMac(ua: string, plat: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(plat) || /Mac OS X|iPhone|iPad/i.test(ua);
}

export interface InstallCopy {
  /** Small heading over the button: WHAT the button delivers. */
  appHeading: string;
  /** Small heading over the curl row. Server's one-liner installs the CLI,
   * the client's installs the SAME desktop app, so the heading is per kind
   * rather than one word stretched over both. */
  curlHeading: string;
  downloadHref: string;
  downloadLabel: string;
  altLabel: string;
  altHref: string;
  artifactFile: string | null;
  curlCommand: string | null;
}

/** Every string the install column shows, computed from the manifest alone
 * (spec 2026-09-23 §4): no version or filename is ever hardcoded. */
export function installCopy(manifest: ReleasesManifest, kind: InstallKind, isMac: boolean): InstallCopy {
  const desktopKey = kind === "server" ? "desktop-server" : "desktop-client";
  const desktop = manifest.components[desktopKey];
  const generic = `https://github.com/${REPO}/releases`;
  const target = isMac ? "darwin-arm64" : "linux-x64";
  const productName = kind === "server" ? "Subshell Server" : "Subshell Client";

  let curlCommand: string | null = null;
  if (kind === "server") {
    const script = manifest.components["cli-server"]?.installScript;
    if (script) curlCommand = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/${script} | bash`;
  } else {
    const script = desktop?.installScript;
    if (script) curlCommand = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/${script} | bash`;
  }

  // DIRECT asset URLs. The manifest entry's `url` is the release PAGE, but
  // nothing requires the button to send people there: the tag is the
  // manifest's, and the filename is `desktopArtifactFileName`'s, the same
  // derivation whose output the column already prints in the small print.
  // Deriving keeps the no-hardcoded-artifact rule (AGENTS.md) intact while
  // the click starts the download (GitHub 302s to the asset host).
  const assetHref = (assetTarget: string): string | null => {
    if (desktop === undefined) return null;
    const file = desktopArtifactFileName(productName, assetTarget, desktop.version);
    return `https://github.com/${REPO}/releases/download/${desktop.tag}/${file}`;
  };
  const otherTarget = isMac ? "linux-x64" : "darwin-arm64";

  return {
    appHeading: `${productName} desktop app`,
    curlHeading: kind === "server" ? "or the CLI" : "The same app, one command",
    downloadHref: assetHref(target) ?? generic,
    downloadLabel: isMac ? "Download for macOS · .dmg" : "Download for Linux · .deb",
    altLabel: isMac ? "Linux (.deb)" : "macOS (.dmg)",
    altHref: assetHref(otherTarget) ?? generic,
    artifactFile: desktop ? desktopArtifactFileName(productName, target, desktop.version) : null,
    curlCommand,
  };
}
