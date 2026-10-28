import { describe, expect, it } from "bun:test";
import { probeWindowMs } from "./ports.js";

/**
 * The scan's time budget, checked as arithmetic rather than on a loaded host.
 * Two pressures meet here and each has been broken on its own: a floor so a
 * slow /proc walk still lets some port be probed (otherwise the picker empties
 * while the dev server was fine all along), and a ceiling the whole pass fits
 * inside (otherwise the plane times the command out and discovery answers
 * NOTHING, the one outcome worse than a dropped tail). Asserting this through a
 * real scan needs a 9 s filesystem, so the window is a pure function.
 */
describe("probeWindowMs", () => {
  it("gives a fresh scan the window its candidate count warrants, up to the ceiling", () => {
    expect(probeWindowMs(0, 4)).toBe(2_500 + 4 * 250);
    expect(probeWindowMs(0, 100)).toBe(6_000);
  });

  it("lifts a nearly-starved scan to the probe floor", () => {
    // Five seconds of walk leaves one second under the ceiling; the floor is
    // what keeps that from answering an empty picker for a pane that has a
    // perfectly good dev server.
    expect(probeWindowMs(5_000, 4)).toBe(1_500);
  });

  it("never lets the floor outrun the plane's command budget", () => {
    // The regression this pins: the floor used to be an unconditional minimum,
    // so a 9 s walk still bought 1.5 s of probing and the command died on the
    // 10 s timeout, taking the whole answer with it.
    expect(probeWindowMs(8_000, 40)).toBe(1_000);
    expect(probeWindowMs(8_999, 40)).toBe(1);
    expect(probeWindowMs(9_000, 40)).toBe(0);
    expect(probeWindowMs(60_000, 40)).toBe(0);
  });
});
