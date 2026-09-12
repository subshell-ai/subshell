import { describe, expect, it } from "bun:test";
import type { NodeSettings, Probe, ProbeStep } from "@/lib/ipc";
import { screenFor, screenTitle, serviceAction } from "@/lib/node-assistant-state";

const settings = (planeUrl: string | null): NodeSettings => ({ planeUrl, agentBinPath: null }) as NodeSettings;

const probe = (step: ProbeStep): Probe => ({ step }) as Probe;

describe("screenFor", () => {
  it("asks for a server first, whatever the machine's state", () => {
    expect(screenFor(probe("online"), settings(null), null)).toBe("connect");
    expect(screenFor(probe("no-agent"), settings(null), null)).toBe("connect");
  });

  it("maps every probe step to one screen once a plane is known", () => {
    expect(screenFor(probe("no-agent"), settings("https://p"), null)).toBe("install-agent");
    expect(screenFor(probe("not-enrolled"), settings("https://p"), null)).toBe("enroll");
    for (const step of ["no-service", "stopped", "offline"] as const) {
      expect(screenFor(probe(step), settings("https://p"), null)).toBe("service");
    }
    expect(screenFor(probe("online"), settings("https://p"), null)).toBe("connected");
  });

  it("honours a user-chosen screen over the machine's", () => {
    expect(screenFor(probe("online"), settings("https://p"), "enroll")).toBe("enroll");
    expect(screenFor(probe("online"), settings("https://p"), "reset")).toBe("reset");
  });

  it("is null while nothing has been read yet", () => {
    expect(screenFor(undefined, undefined, null)).toBeNull();
    expect(screenFor(undefined, settings("https://p"), null)).toBeNull();
  });

  it("routes a step this build predates to the service screen, which shows the facts", () => {
    expect(screenFor(probe("what-even" as ProbeStep), settings("https://p"), null)).toBe("service");
  });
});

describe("screenTitle", () => {
  it("speaks the assistant's voice, and says which service failure it is", () => {
    expect(screenTitle("connect", undefined)).toBe("Connect to a Server");
    expect(screenTitle("install-agent", undefined)).toBe("Install the Agent");
    expect(screenTitle("enroll", undefined)).toBe("Enroll This Machine");
    expect(screenTitle("service", probe("offline"))).toBe("The Node Service Isn't Responding");
    expect(screenTitle("service", probe("stopped"))).toBe("The Node Service Is Stopped");
    expect(screenTitle("service", probe("no-service"))).toBe("Start the Node Service");
    expect(screenTitle("connected", undefined)).toBe("This Machine Is a Node");
  });

  it("names the product rather than the computer, identically on both platforms", () => {
    // Two regressions pinned at once, both reported from a screenshot on
    // 2026-09-12. "Reset This Mac" reads as erasing the computer, which is
    // not remotely what this does; and a label ending on "Mac" reads as a
    // truncated "Machine", against a sibling string that really is "This
    // Machine". This is the one title that names no machine on any platform.
    expect(screenTitle("reset", undefined)).toBe("Reset this client");
    // And the rule it became: NO title names a Mac, because there is one word
    // for where you are and it is "This Machine" (operator's call,
    // 2026-09-12). A title is a label; a label that might have been cut off is
    // a bug report waiting to happen.
    // And the shape of the bug it fixed: no title may END on "Mac", which is
    // what reads as a truncated "Machine" under a button's ellipsis. `endsWith`
    // rather than `contains`, because "This Machine" contains "Mac" — that
    // prefix relationship IS the misreading, so the check has to be about
    // where the string stops.
    const every = ["connect", "install-agent", "enroll", "service", "connected", "reset"] as const;
    for (const screen of every) {
      expect(screenTitle(screen, undefined).endsWith("Mac"), screen).toBe(false);
    }
  });
});

describe("serviceAction", () => {
  it("offers the one verb the step needs", () => {
    expect(serviceAction("no-service")).toEqual({ label: "Install and Start", verb: "install" });
    expect(serviceAction("stopped")).toEqual({ label: "Start", verb: "start" });
    expect(serviceAction("offline")).toEqual({ label: "Restart", verb: "restart" });
    expect(serviceAction("online")).toBeNull();
    expect(serviceAction("no-agent")).toBeNull();
    expect(serviceAction("not-enrolled")).toBeNull();
  });
});
