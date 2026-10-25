import { PreviewDisplays } from "./display.js";

/** Probe the bundled default without allocating resources. */
export function previewDisplayReadiness() {
  return new PreviewDisplays("").readiness();
}
