import { describe, expect, it } from "bun:test";
import type { ActionResult, Probe } from "../lib/ipc";
import { canSetup, dots, failureLine, prereqState, screensFor, setupRows } from "../lib/wizard-state";

function virgin(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.0.0",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: null,
    platform: "darwin",
    hasBrew: true,
    onboarded: false,
    hostname: "mac",
    ...over,
  } as Probe;
}
const NO_EDITS = { port: "", host: "" };
const WITH_TMUX = { tmux: "/opt/homebrew/bin/tmux" };

describe("screensFor", () => {
  it("shows the tmux screen only while tmux is missing", () => {
    expect(screensFor(virgin())).toEqual(["welcome", "tmux", "setup"]);
    expect(screensFor(virgin(WITH_TMUX))).toEqual(["welcome", "setup"]);
  });
});

describe("dots", () => {
  it("always has three positions", () => expect(dots(virgin(), "welcome").total).toBe(3));
  it("counts a skipped tmux screen as done", () => {
    expect(dots(virgin(WITH_TMUX), "setup")).toEqual({ total: 3, done: 2, current: 2 });
    expect(dots(virgin(WITH_TMUX), "welcome")).toEqual({ total: 3, done: 0, current: 0 });
  });
  it("walks the three when tmux is missing", () => {
    expect(dots(virgin(), "tmux")).toEqual({ total: 3, done: 1, current: 1 });
    expect(dots(virgin(), "setup")).toEqual({ total: 3, done: 2, current: 2 });
  });
});

describe("setupRows", () => {
  it("is five rows, tmux first, all pending on a virgin machine", () => {
    const rows = setupRows(virgin(), NO_EDITS);
    expect(rows.map((r) => r.id)).toEqual(["tmux", "server", "config", "service", "running"]);
    expect(rows.every((r) => !r.done)).toBe(true);
  });
  it("ticks from facts, never optimism", () => {
    const p = virgin({
      ...WITH_TMUX,
      server: { argv: ["/x/subshell-server"], source: "local-bin", version: "1.0.0" },
      status: { configEnv: { exists: true } } as never,
      service: { installed: true } as never,
      next: "start",
    });
    const done = Object.fromEntries(setupRows(p, NO_EDITS).map((r) => [r.id, r.done]));
    expect(done).toEqual({ tmux: true, server: true, config: true, service: true, running: false });
  });
  it("details name the defaults until Customize edits them", () => {
    expect(setupRows(virgin(), NO_EDITS).find((r) => r.id === "config")?.detail).toBe("port 3080, all interfaces");
    expect(setupRows(virgin(), { port: "4000", host: "127.0.0.1" }).find((r) => r.id === "config")?.detail).toBe(
      "port 4000, 127.0.0.1",
    );
  });
});

describe("canSetup", () => {
  it("refuses with a reason while no probe has answered", () =>
    expect(canSetup(null, false)).toEqual({ ok: false, reason: "Checking this machine…" }));
  it("refuses silently while busy", () => expect(canSetup(virgin(WITH_TMUX), true)).toEqual({ ok: false, reason: "" }));
  it("waits for tmux, the chain's one hard stop", () =>
    expect(canSetup(virgin(), false)).toEqual({ ok: false, reason: "Waiting for tmux" }));
  it("is ok once tmux answers, even with no server yet", () =>
    expect(canSetup(virgin(WITH_TMUX), false)).toEqual({ ok: true }));
});

describe("failureLine", () => {
  const r = (stdout: string, stderr: string): ActionResult => ({ ok: false, stdout, stderr });
  it("takes the last non-empty stderr line", () =>
    expect(failureLine(r("installing…\n", "warning: x\nrefused: no tmux on PATH\n\n"))).toBe(
      "refused: no tmux on PATH",
    ));
  it("falls back to stdout's last line", () =>
    expect(failureLine(r("step one\nstep two failed", ""))).toBe("step two failed"));
  it("has a fixed sentence when both are empty", () => expect(failureLine(r("", "  \n"))).toBe("Setup stopped."));
});

describe("prereqState", () => {
  it("found when tmux answers", () => expect(prereqState(virgin(WITH_TMUX))).toBe("found"));
  it("install where a plan exists", () => expect(prereqState(virgin({ hasBrew: true }))).toBe("install"));
  it("manual on a Mac without Homebrew", () => expect(prereqState(virgin({ hasBrew: false }))).toBe("manual"));
});
