import { describe, expect, it } from "bun:test";
import { providerForMachine } from "@/lib/display-provider-choice";

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
