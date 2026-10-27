import { describe, expect, it } from "bun:test";
import { displayFieldOwnsRefusal, splitLaunchError } from "@/lib/display-refusal-routing";

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

describe("displayFieldOwnsRefusal", () => {
  // The condition the three dialogs hand `splitLaunchError`, kept as one tested
  // function because the failure mode is silence: with the box term dropped, a
  // display refusal under an unchecked checkbox goes to a field that hides it,
  // the form line is empty too, and no suite notices a message vanishing.
  it("gives the line to the field only while it is mounted AND switched on", () => {
    expect(displayFieldOwnsRefusal({ mounted: true, virtualDisplay: true })).toBe(true);
    expect(displayFieldOwnsRefusal({ mounted: true, virtualDisplay: false })).toBe(false);
    expect(displayFieldOwnsRefusal({ mounted: true, virtualDisplay: undefined })).toBe(false);
    expect(displayFieldOwnsRefusal({ mounted: false, virtualDisplay: true })).toBe(false);
    expect(displayFieldOwnsRefusal({ mounted: false, virtualDisplay: false })).toBe(false);
  });

  it("leaves the form holding the refusal when the field does not", () => {
    // The two halves of the pair, asserted together: exactly one of them owns
    // any given message, and "neither" is the bug this pins shut.
    const REFUSAL = "API 400: no display for you. (preview-display-not-ready: x)";
    const off = splitLaunchError(REFUSAL, displayFieldOwnsRefusal({ mounted: true, virtualDisplay: false }));
    expect(off.field).toBeNull();
    expect(off.form).toBe(REFUSAL);
    const on = splitLaunchError(REFUSAL, displayFieldOwnsRefusal({ mounted: true, virtualDisplay: true }));
    expect(on.form).toBeNull();
    expect(on.field).toBe(REFUSAL);
  });
});
