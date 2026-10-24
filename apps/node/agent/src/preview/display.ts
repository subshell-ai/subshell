import { type DisplayDeps, PreviewDisplays as RuntimePreviewDisplays } from "@internal/pane-runtime";
import { log } from "../log.js";
import { getPreviewEnabled } from "./flags.js";

export type { DisplayChild, DisplayDeps, DisplaySweepResult } from "@internal/pane-runtime";
export {
  PREVIEW_DISPLAY_MISSING_BINARIES,
  PREVIEW_DISPLAY_NOT_READY,
  PREVIEW_DISPLAY_UNSUPPORTED,
  xauthorityPath,
} from "@internal/pane-runtime";
export class PreviewDisplays extends RuntimePreviewDisplays {
  constructor(dataDir: string, deps: DisplayDeps = {}) {
    super(dataDir, { ...deps, isEnabled: () => getPreviewEnabled(dataDir)?.on === true, log });
  }
}
