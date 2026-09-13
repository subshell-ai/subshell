// Pins the measured constraint: a plugin CANNOT import our packages, which is
// the entire reason the host object exists. If this ever starts working, the
// contract has quietly changed and the loader test will say so.
import { TmuxRunner } from "@internal/pane-runtime";
export default () => ({
  buildCommand: () => [String(TmuxRunner)],
  validatePreset: () => ({ valid: true, issues: [] }),
  capabilities: () => [],
});
