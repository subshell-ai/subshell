import { describe, expect, it } from "bun:test";
import { nodeDefaultForMachine, providerForMachine, providersForMachine } from "@/lib/display-provider-choice";

/**
 * What a machine change does to the saved display provider. The failure this
 * pins: the picker's list is filtered by the node's OS, but the FORM still
 * carries the old pick, so switching a Mac launch to a Linux node kept
 * BetterDisplay selected and asked the node to allocate with it - the refusal
 * arrives after Start, which is exactly what the OS gate was added to avoid.
 */
describe("providerForMachine", () => {
  it("keeps a provider the new machine can run", () => {
    expect(providerForMachine("betterdisplay", "darwin")).toBe("betterdisplay");
    expect(providerForMachine("xvfb-x11vnc", "linux")).toBe("xvfb-x11vnc");
  });

  it("drops a bundled provider the new machine cannot run", () => {
    // Back to undefined, which means the node's own default: a greyed-out row
    // would still launch with the impossible provider.
    expect(providerForMachine("betterdisplay", "linux")).toBeUndefined();
    expect(providerForMachine("xvfb-x11vnc", "darwin")).toBeUndefined();
  });

  it("clears nothing while the machine's OS is unknown", () => {
    // The node list is usually still loading when these forms mount, and a
    // pick lost to that first read is data the person saved (a preset's whole
    // screen choice). An unknown OS is not a verdict that the machine cannot
    // run it; the readiness answer and the launch refusal are.
    expect(providerForMachine("xvfb-x11vnc", null)).toBe("xvfb-x11vnc");
    expect(providerForMachine("xvfb-x11vnc", undefined)).toBe("xvfb-x11vnc");
    expect(providerForMachine(undefined, "linux")).toBeUndefined();
  });

  it("leaves an id this package does not ship alone", () => {
    // A node-owned provider: no surface here has a platform fact about it, so
    // the node's own readiness answer is what rules it in or out.
    expect(providerForMachine("acme-screen", "linux")).toBe("acme-screen");
  });

  it("has nothing to clear when nothing was picked", () => {
    expect(providerForMachine(undefined, "linux")).toBeUndefined();
  });
});

/**
 * The list half of the same reading. These two functions disagreeing is how a
 * preset editor came to show "Node default" over a saved pin: the value was
 * kept (no OS fact yet) while the list was emptied (the unknown OS read as
 * "not Linux"), so the trigger could only name a choice that was not the one
 * about to launch.
 */
describe("providersForMachine", () => {
  const BOTH = ["xvfb-x11vnc", "betterdisplay"];

  it("filters to what the answered OS can run", () => {
    expect(providersForMachine(BOTH, "linux")).toEqual(["xvfb-x11vnc"]);
    expect(providersForMachine(BOTH, "darwin")).toEqual(["betterdisplay"]);
  });

  it("filters nothing while the OS is unknown", () => {
    expect(providersForMachine(BOTH, null)).toEqual(BOTH);
    expect(providersForMachine(BOTH, undefined)).toEqual(BOTH);
  });

  it("leaves a node-owned id listed whatever the answer", () => {
    expect(providersForMachine(["acme-screen", "betterdisplay"], "linux")).toEqual(["acme-screen"]);
    expect(providersForMachine(["acme-screen", "betterdisplay"], null)).toEqual(["acme-screen", "betterdisplay"]);
  });

  it("returns a copy, not the caller's array", () => {
    const source = Object.freeze(BOTH);
    expect(providersForMachine(source, null)).toEqual(BOTH);
  });
});

describe("nodeDefaultForMachine", () => {
  it("names a default only when that machine could run it", () => {
    // A label reading "Node default (Xvfb + VNC)" on a Mac teaches the reader
    // that the parenthetical is decorative.
    expect(nodeDefaultForMachine("xvfb-x11vnc", "linux")).toBe("xvfb-x11vnc");
    expect(nodeDefaultForMachine("xvfb-x11vnc", "darwin")).toBeUndefined();
    expect(nodeDefaultForMachine("xvfb-x11vnc", null)).toBe("xvfb-x11vnc");
    expect(nodeDefaultForMachine(undefined, "linux")).toBeUndefined();
  });
});
