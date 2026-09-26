import { desktopArtifactFileName } from "@internal/subshell-protocol";
import type { ReleasesManifest } from "./releases";
import { SITE_ORIGIN } from "./site";

export type { ReleasesManifest };

export type InstallKind = "server" | "client";

/** The two Mac bundles a visitor can choose between, when the release ships both. */
export type MacArch = "darwin-arm64" | "darwin-x64";

const REPO = "subshell-ai/subshell";

// SITE_ORIGIN (the curl one-liners' host) lives in ./site.ts, shared with
// layout/robots/sitemap; its comment carries the install-script hosting
// story.

/** Human labels for the arch choice and the menu items. */
export const MAC_ARCH_LABEL: Record<MacArch, string> = {
  "darwin-arm64": "Apple silicon",
  "darwin-x64": "Intel",
};

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

const productNameFor = (kind: InstallKind): string => (kind === "server" ? "Subshell Server" : "Subshell Client");

/**
 * Does the newest cut of this kind verifiably carry an Intel bundle?
 *
 * The answer comes from the release's own signed asset list (`desktopAssets`,
 * gathered by scripts/site-releases.ts), matched against the DERIVED file
 * name — never a substring of a blob, and never an assumption: no probe
 * data, or a probe that found no Intel dmg, and the site offers no choice.
 */
export function macIntelAvailable(manifest: ReleasesManifest, kind: InstallKind): boolean {
  const desktop = manifest.components[kind === "server" ? "desktop-server" : "desktop-client"];
  if (desktop?.desktopAssets === undefined) return false;
  return desktop.desktopAssets.includes(desktopArtifactFileName(productNameFor(kind), "darwin-x64", desktop.version));
}

/** Every string the install column shows, computed from the manifest alone
 * (spec 2026-09-23 §4): no version or filename is ever hardcoded. */
export function installCopy(
  manifest: ReleasesManifest,
  kind: InstallKind,
  isMac: boolean,
  macArch: MacArch = "darwin-arm64",
): InstallCopy {
  const desktopKey = kind === "server" ? "desktop-server" : "desktop-client";
  const desktop = manifest.components[desktopKey];
  const generic = `https://github.com/${REPO}/releases`;
  const target = isMac ? macArch : "linux-x64";
  const productName = productNameFor(kind);

  let curlCommand: string | null = null;
  if (kind === "server") {
    const script = manifest.components["cli-server"]?.installScript;
    if (script) curlCommand = `curl -fsSL ${SITE_ORIGIN}/${script} | bash`;
  } else {
    const script = desktop?.installScript;
    if (script) curlCommand = `curl -fsSL ${SITE_ORIGIN}/${script} | bash`;
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
    // The arch names itself on the button only when there IS a choice to
    // name; a release without an Intel bundle keeps the plain macOS label
    // rather than advertising "Apple silicon" as if it were an alternative.
    // `Name (.ext)` is the column's idiom for every download word (operator
    // choice, 2026-09-25): the menu rows and the alt link already spoke it.
    downloadLabel: !isMac
      ? "Download for Linux (.deb)"
      : macIntelAvailable(manifest, kind)
        ? `Download for ${MAC_ARCH_LABEL[macArch]} (.dmg)`
        : "Download for macOS (.dmg)",
    altLabel: isMac ? "Linux (.deb)" : "macOS (.dmg)",
    altHref: assetHref(otherTarget) ?? generic,
    artifactFile: desktop ? desktopArtifactFileName(productName, target, desktop.version) : null,
    curlCommand,
  };
}
