import { describe, expect, it } from "bun:test";
import type { Probe } from "../lib/ipc";
import { canContinue, firstOpenStep, prereqState, runRows } from "../lib/wizard-state";

/** A virgin machine: nothing found, one bundled. */
const virgin = (over: Partial<Probe> = {}): Probe =>
  ({
    bundledVersion: "1.2.3",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: null,
    platform: "linux",
    hasBrew: false,
    onboarded: false,
    hostname: "box",
    ...over,
  }) as Probe;

describe("firstOpenStep", () => {
  it("starts a virgin machine at welcome", () => expect(firstOpenStep(virgin())).toBe("welcome"));
  it("resumes past tmux once it answers", () =>
    expect(firstOpenStep(virgin({ tmux: "/usr/bin/tmux" }))).toBe("addresses"));
  it("resumes past addresses once config exists", () =>
    expect(
      firstOpenStep(
        virgin({
          tmux: "/t",
          next: "install-service",
          status: { configEnv: { path: "/c", exists: true } } as Probe["status"],
        }),
      ),
    ).toBe("run"));
});

describe("prereqState", () => {
  it("found when tmux answers", () => expect(prereqState(virgin({ tmux: "/usr/bin/tmux" }))).toBe("found"));
  it("install where a plan exists", () => {
    expect(prereqState(virgin())).toBe("install"); // linux has a pkexec plan
    expect(prereqState(virgin({ platform: "darwin", hasBrew: true }))).toBe("install");
  });
  it("manual where it does not", () =>
    expect(prereqState(virgin({ platform: "darwin", hasBrew: false }))).toBe("manual"));
});

describe("runRows", () => {
  it("ticks from facts, never optimism", () => {
    const rows = runRows(virgin({ server: { argv: ["/x"], source: "local-bin", version: "1" }, tmux: "/t" }));
    expect(rows.map((r) => r.done)).toEqual([true, false, false, false]);
  });
  it("all four ticked at ready", () => {
    const p = virgin({
      tmux: "/t",
      next: "ready",
      server: { argv: ["/x"], source: "local-bin", version: "1" },
      status: { configEnv: { path: "/c", exists: true } } as Probe["status"],
      service: { installed: true, state: "running" } as Probe["service"],
    });
    expect(runRows(p).every((r) => r.done)).toBe(true);
  });
});

describe("canContinue", () => {
  it("gates the wizard only where the CLI will", () => {
    expect(canContinue("prerequisites", virgin(), false)).toBe(false); // no tmux
    expect(canContinue("prerequisites", virgin({ tmux: "/t" }), false)).toBe(true);
    expect(canContinue("addresses", virgin(), false)).toBe(true); // the step asks for nothing
    expect(canContinue("run", virgin(), true)).toBe(false); // busy is busy
    expect(
      canContinue("run", virgin({ tmux: "/t", server: { argv: ["/x"], source: "path", version: "1" } }), false),
    ).toBe(true);
    // The two conditions above move together; these two pin each alone, so
    // a future edit to either gate fails a test that names it.
    expect(canContinue("run", virgin(), false)).toBe(false); // no tmux blocks, even when idle
    expect(
      canContinue("run", virgin({ tmux: "/t", server: { argv: ["/x"], source: "path", version: "1" } }), true),
    ).toBe(false); // busy gates independently of the facts
  });
});
