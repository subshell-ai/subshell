import { describe, expect, it } from "bun:test";
import {
  bundledProvidersForMachine,
  nodeDefaultForMachine,
  offeredDisplayProviders,
  providerForMachine,
  providersForMachine,
} from "@/lib/display-provider-choice";

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

  for (const unanswered of [null, undefined, "unknown"]) {
    it(`clears nothing while the machine's OS has not answered (${String(unanswered)})`, () => {
      // Two shapes reach this: no node chosen or the list still loading (null
      // and undefined), and a node that reported the protocol's own "unknown"
      // because it is neither Linux nor macOS. Both are the absence of a
      // verdict, and a pick lost to either is data the person saved (a preset's
      // whole screen choice). What the machine cannot run is decided by its
      // readiness answer and the launch refusal, not by this reading.
      expect(providerForMachine("xvfb-x11vnc", unanswered)).toBe("xvfb-x11vnc");
      expect(providerForMachine("betterdisplay", unanswered)).toBe("betterdisplay");
    });
  }

  it("has nothing to clear when no provider was picked", () => {
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

  for (const unanswered of [null, undefined, "unknown"]) {
    it(`filters nothing while the OS has not answered (${String(unanswered)})`, () => {
      expect(providersForMachine(BOTH, unanswered)).toEqual(BOTH);
    });
  }

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
    // A node that cannot name its own platform still HAS a default, and the
    // label may name it: nothing here has contradicted it.
    expect(nodeDefaultForMachine("xvfb-x11vnc", "unknown")).toBe("xvfb-x11vnc");
    expect(nodeDefaultForMachine(undefined, "linux")).toBeUndefined();
  });
});

describe("bundledProvidersForMachine", () => {
  it("keeps the whole catalog while the OS has not answered", () => {
    // The node settings card is the owner's only path to pre-enable a provider
    // on a machine that has not classified itself, so this reading has to match
    // the other three: no verdict filters nothing.
    for (const unanswered of [null, undefined, "unknown"]) {
      expect(bundledProvidersForMachine(unanswered).map((p) => p.id)).toEqual(["xvfb-x11vnc", "betterdisplay"]);
    }
    expect(bundledProvidersForMachine("linux").map((p) => p.id)).toEqual(["xvfb-x11vnc"]);
    expect(bundledProvidersForMachine("darwin").map((p) => p.id)).toEqual(["betterdisplay"]);
  });
});

describe("offeredDisplayProviders", () => {
  it("keeps a pick the node has not enabled on the list it is being refused for", () => {
    // The launch form lists what this node's owner enabled. A preset pinning
    // BetterDisplay on a Mac whose only enabled provider is Xvfb is refused by
    // the plane, and the gold reason beside this row tells the person to choose
    // another provider, so the row naming the choices has to show the one that
    // sentence is about: without it the trigger read "Node default" over the
    // provider being refused, and re-picking "Node default" changed nothing.
    expect(offeredDisplayProviders(["xvfb-x11vnc"], "darwin", "betterdisplay")).toEqual(["betterdisplay"]);
    // Already offered, so nothing is added twice; nothing held, so nothing shows.
    expect(offeredDisplayProviders(["xvfb-x11vnc", "betterdisplay"], "darwin", "betterdisplay")).toEqual([
      "betterdisplay",
    ]);
    expect(offeredDisplayProviders(["xvfb-x11vnc", "betterdisplay"], "darwin", undefined)).toEqual(["betterdisplay"]);
  });

  it("still refuses the provider the OS gate removed", () => {
    // The other half of the rule, and the reason the row is not simply the
    // unfiltered list: what this machine cannot run is not a choice, and offering
    // it would put back what the caller's clearing rule takes away.
    expect(offeredDisplayProviders(["betterdisplay"], "linux", "betterdisplay")).toEqual([]);
    expect(offeredDisplayProviders(["xvfb-x11vnc"], "linux", "betterdisplay")).toEqual(["xvfb-x11vnc"]);
  });

  it("lists a held id this package does not ship, like any other held pick", () => {
    // A node-owned provider: no surface here has a platform fact about it, so the
    // node's own readiness answer rules it, and the row shows what will launch.
    expect(offeredDisplayProviders(["xvfb-x11vnc"], "darwin", "acme-screen")).toEqual(["acme-screen"]);
    expect(offeredDisplayProviders(["xvfb-x11vnc"], null, "acme-screen")).toEqual(["xvfb-x11vnc", "acme-screen"]);
  });
});
