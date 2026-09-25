import { desktopArtifactFileName } from "@internal/subshell-protocol";
import type { ReleasesManifest } from "./releases";

export type { ReleasesManifest };

export type InstallKind = "server" | "client";

const REPO = "subshell-ai/subshell";

export function detectIsMac(ua: string, plat: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(plat) || /Mac OS X|iPhone|iPad/i.test(ua);
}

export interface InstallCopy {
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

  return {
    downloadHref: desktop?.url ?? generic,
    downloadLabel: isMac ? "Download for macOS · .dmg" : "Download for Linux · .deb",
    altLabel: isMac ? "Linux (.deb)" : "macOS (.dmg)",
    altHref: generic,
    artifactFile: desktop ? desktopArtifactFileName(productName, target, desktop.version) : null,
    curlCommand,
  };
}
