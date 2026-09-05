import { describe, expect, it } from "bun:test";
import { agentVersionSupported, MIN_AGENT_VERSION, semverLt } from "../versions.js";

describe("semverLt", () => {
  it("orders by numeric component, not lexically", () => {
    // "0.10.0" < "0.9.0" is the string answer and the wrong one.
    expect(semverLt("0.9.0", "0.10.0")).toBe(true);
    expect(semverLt("0.10.0", "0.9.0")).toBe(false);
    expect(semverLt("1.5.0", "1.5.0")).toBe(false);
  });

  it("treats a missing component as zero, in both directions", () => {
    expect(semverLt("1.4", "1.4.1")).toBe(true);
    expect(semverLt("1.4.0", "1.4")).toBe(false);
    expect(semverLt("2", "1.9.9")).toBe(false);
  });

  it("ignores a suffix, so a prerelease of X satisfies a floor of X", () => {
    // Deliberate: a `-canary` build of the required version is the required
    // version. Refusing it would strand exactly the people testing a release.
    expect(semverLt("0.3.0-canary.1", "0.3.0")).toBe(false);
    expect(semverLt("0.2.9-canary.1", "0.3.0")).toBe(true);
  });

  it("reads an unparseable version as 0, the oldest thing there is", () => {
    expect(semverLt("", "0.0.1")).toBe(true);
    expect(semverLt("not-a-version", "0.0.1")).toBe(true);
  });
});

describe("agentVersionSupported", () => {
  it("admits the floor itself and anything newer", () => {
    expect(agentVersionSupported(MIN_AGENT_VERSION)).toBe(true);
    expect(agentVersionSupported("99.0.0")).toBe(true);
  });

  it("refuses anything older", () => {
    expect(agentVersionSupported("0.0.1")).toBe(false);
  });

  it("refuses an agent that cannot say what it is", () => {
    // A build with no version is not assumed current: the whole point of the
    // floor is that the operator gets told what to install, and a nameless
    // build gives them nothing to compare against.
    for (const v of [null, undefined, "", "unknown"]) {
      expect(agentVersionSupported(v)).toBe(false);
    }
  });
});
