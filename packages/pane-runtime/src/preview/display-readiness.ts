import { PREVIEW_DISPLAY_BINARIES, type PreviewDisplayReadiness } from "@internal/subshell-protocol";

/** Read-only preflight using the same process PATH as display allocation. */
export function previewDisplayReadiness(
  which: (name: string) => string | null = (name) => Bun.which(name),
  platform: string = process.platform,
): PreviewDisplayReadiness {
  return {
    supported: platform === "linux",
    missing: platform === "linux" ? PREVIEW_DISPLAY_BINARIES.filter((name) => !which(name)) : [],
  };
}
