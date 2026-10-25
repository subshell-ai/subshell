import { type PreviewDisplayOptions, PreviewDisplays as RuntimePreviewDisplays } from "@internal/pane-runtime";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { getPreviewEnabled, getVirtualDisplayEnabled } from "./flags.js";

export {
  PREVIEW_DISPLAY_MISSING_REQUIREMENTS,
  PREVIEW_DISPLAY_NOT_READY,
  PREVIEW_DISPLAY_UNSUPPORTED,
} from "@internal/pane-runtime";
export class PreviewDisplays extends RuntimePreviewDisplays {
  constructor(dataDir: string, options: Pick<PreviewDisplayOptions, "provider"> = {}) {
    super(dataDir, {
      ...options,
      isEnabled: () => getVirtualDisplayEnabled(dataDir),
      getEnabledProviderIds: () => getPreviewEnabled(dataDir)?.displayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER],
      getProviderId: () => getPreviewEnabled(dataDir)?.displayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
      log,
    });
  }
}
