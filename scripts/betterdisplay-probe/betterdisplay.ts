// The probe has its own namespace but shares production ownership and discard guards.
import { betterDisplayCommands } from "../../packages/pane-runtime/src/preview/betterdisplay-cli.js";

export {
  commandRunner,
  ExistingDisplayError as ExistingProbeDisplayError,
  type OwnedDisplay,
  type Run,
} from "../../packages/pane-runtime/src/preview/betterdisplay-cli.js";
export const {
  displayName: probeName,
  validateName,
  parseIdentifiers,
  ownedDisplay,
  inspectDisplay,
  createDisplay,
  removeDisplay,
} = betterDisplayCommands("Subshell-Probe-");
