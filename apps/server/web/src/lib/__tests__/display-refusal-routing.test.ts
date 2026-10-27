import { describe, expect, it } from "bun:test";
import { splitLaunchError } from "@/lib/display-refusal-routing";

/**
 * The one place the "a refusal renders in exactly one spot" rule is written, so
 * the three launch dialogs cannot each drift back to their own copy. The failure
 * this pins: a display refusal is routed away from the form line to a checkbox
 * that the mode or kind toggle has just unmounted, and the person is left with a
 * failed Create and no explanation anywhere on screen.
 */
const DISPLAY_REFUSAL = "Virtual displays are disabled on this node. (preview-node-off)";
const OTHER_FAILURE = "The node refused to start the harness.";

describe("splitLaunchError", () => {
  it("gives a display refusal to the field while the field is mounted", () => {
    expect(splitLaunchError(DISPLAY_REFUSAL, true)).toEqual({ field: DISPLAY_REFUSAL, form: null });
  });

  it("gives the same refusal back to the form line when the field is gone", () => {
    // The case that used to vanish: `kind === "ssh"` or the existing-subshell
    // mode unmounts the checkbox while the error is still set.
    expect(splitLaunchError(DISPLAY_REFUSAL, false)).toEqual({ field: null, form: DISPLAY_REFUSAL });
  });

  it("leaves every other failure on the form line, mounted field or not", () => {
    expect(splitLaunchError(OTHER_FAILURE, true)).toEqual({ field: null, form: OTHER_FAILURE });
    expect(splitLaunchError(OTHER_FAILURE, false)).toEqual({ field: null, form: OTHER_FAILURE });
  });

  it("says nothing when there is nothing to say", () => {
    expect(splitLaunchError(null, true)).toEqual({ field: null, form: null });
  });
});
