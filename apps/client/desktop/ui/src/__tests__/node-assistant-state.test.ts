import { describe, expect, it } from "bun:test";
import type { NodeSettings, Probe, ProbeStep } from "@/lib/ipc";
import { screenFor, screenTitle, serviceAction } from "@/lib/node-assistant-state";

const settings = (planeUrl: string | null): NodeSettings =>
  ({ planeUrl, agentBinPath: null, closeToTray: true, traySupported: true, trayStatus: "supported" }) as NodeSettings;

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
    expect(screenTitle("connect", undefined, "darwin")).toBe("Connect to a Server");
    expect(screenTitle("install-agent", undefined, "darwin")).toBe("Install the Agent");
    expect(screenTitle("enroll", undefined, "darwin")).toBe("Enroll This Mac");
    expect(screenTitle("enroll", undefined, "linux")).toBe("Enroll This Machine");
    expect(screenTitle("service", probe("offline"), "darwin")).toBe("The Node Service Isn't Responding");
    expect(screenTitle("service", probe("stopped"), "darwin")).toBe("The Node Service Is Stopped");
    expect(screenTitle("service", probe("no-service"), "darwin")).toBe("Start the Node Service");
    expect(screenTitle("connected", undefined, "darwin")).toBe("This Mac Is a Node");
    expect(screenTitle("reset", undefined, "linux")).toBe("Reset This Machine");
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
