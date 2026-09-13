import { describe, expect, it } from "bun:test";
import { lingerNote, supervisionLine } from "@/components/nodes/node-runtime-card";
import type { NodeRuntime } from "@/types/node";

/** A supervised agent, adjustable where a test cares. */
function runtime(over: Partial<NodeRuntime["service"]> = {}, supervised = true): NodeRuntime {
  return {
    startedAt: "2026-09-12T10:00:00.000Z",
    supervised,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/u",
      state: "running",
      pid: 4242,
      enabled: true,
      paneSafety: "keeps",
      ...over,
    },
    configPath: "/c/config.json",
    agentLogPath: "/c/agent.log",
  } as NodeRuntime;
}

describe("supervisionLine", () => {
  it("names the manager, the pid, and whether it comes back at login", () => {
    expect(supervisionLine(runtime())).toBe("systemd (pid 4242) · starts at login");
    expect(supervisionLine(runtime({ enabled: false }))).toBe("systemd (pid 4242)");
    expect(supervisionLine(runtime({}, false))).toBe("Not supervised");
  });
});

describe("lingerNote", () => {
  it("says that starting at login is not staying up after logout, on systemd", () => {
    // The two axes, one layer down from the server's own card: a `--user` unit
    // runs inside the owner's login session, so it comes up at login and goes
    // down at LOGOUT. On a headless box nobody logs into, that is the
    // difference between an agent being there and not.
    expect(lingerNote(runtime())).toContain("enable-linger");
  });

  it("says nothing where the caveat does not apply", () => {
    // launchd has no equivalent knob: a LaunchAgent's lifetime IS the GUI
    // session by design, and a machine with nobody logged in is not running
    // one either way.
    expect(lingerNote(runtime({ manager: "launchd" }))).toBe(null);
    // Nothing arms it, so there is nothing to qualify.
    expect(lingerNote(runtime({ enabled: false }))).toBe(null);
    expect(lingerNote(runtime({ enabled: null }))).toBe(null);
    expect(lingerNote(runtime({}, false))).toBe(null);
  });
});
