import { PreviewDisplays } from "./display.js";

/** Probe the requested provider, or the bundled default, without allocating resources. */
export function previewDisplayReadiness(provider?: string) {
  return new PreviewDisplays("").readiness(provider);
}
