import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionResult, Probe } from "../lib/ipc";
import {
  canSetup,
  dots,
  failureLine,
  prereqState,
  RESET_LABEL,
  recoveryAction,
  recoveryTitle,
  screensFor,
  setupRows,
} from "../lib/wizard-state";

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
    expect(screensFor(virgin(), false)).toEqual(["welcome", "tmux", "setup"]);
    expect(screensFor(virgin(WITH_TMUX), false)).toEqual(["welcome", "setup"]);
  });
});

describe("screensFor with onboarded", () => {
  it("shows exactly the recovery screen once onboarded and not ready", () => {
    for (const step of ["no-server", "unreachable", "init", "install-service", "start"] as const) {
      expect(screensFor(virgin({ ...WITH_TMUX, next: step }), true)).toEqual(["recovery"]);
    }
  });

  it("shows nothing when ready, whichever family the machine is in", () => {
    // The page opens the dashboard and this window goes; a screen list with
    // anything in it would render behind that.
    expect(screensFor(virgin({ ...WITH_TMUX, next: "ready" }), true)).toEqual([]);
    expect(screensFor(virgin({ ...WITH_TMUX, next: "ready" }), false)).toEqual([]);
  });

  it("never lists update or reset: they are entered by request", () => {
    for (const onboarded of [true, false]) {
      for (const step of ["setup", "start", "ready"] as const) {
        const screens = screensFor(virgin({ next: step }), onboarded);
        expect(screens).not.toContain("update");
        expect(screens).not.toContain("reset");
      }
    }
  });
});

describe("RESET_LABEL", () => {
  it("names what is reset, not the computer, and never ends on 'Mac'", () => {
    // Both halves were reported from a screenshot on 2026-09-12, as one bug.
    // "Reset this Mac…" reads as erasing the computer, which is nothing like
    // what this does; and a label ending on "Mac" reads as a truncated
    // "Machine", against a sibling string that really is "this machine" and
    // under the ellipsis a button that opens a screen carries.
    expect(RESET_LABEL).toBe("Reset Subshell");
    expect(RESET_LABEL.endsWith("Mac")).toBe(false);
    // No platform word on either side of the split: everything this app does
    // is on this machine, so saying so was only ever redundant. Subshell
    // Client's reset title is this same string — one act, one name.
    expect(RESET_LABEL).not.toContain("Machine");
    expect(RESET_LABEL).not.toContain("machine");
  });

  it("is the Reset screen's own title too, so the door and the room agree", () => {
    // The markup is static, so this is the only thing holding the two equal.
    // A button labelled one thing opening a screen titled another is its own
    // small betrayal on the one screen that may not be doubted.
    const page = readFileSync(join(import.meta.dir, "../../wizard.html"), "utf8");
    expect(page).toContain(`<p class="reset-title">${RESET_LABEL}</p>`);
  });
});

describe("recoveryTitle / recoveryAction", () => {
  it("names the step in the assistant's voice", () => {
    expect(recoveryTitle("no-server", "darwin")).toBe("No Server Found");
    expect(recoveryTitle("unreachable", "darwin")).toBe("Your Server Isn't Responding");
    expect(recoveryTitle("init", "linux")).toBe("Your Server Needs Its Configuration");
    expect(recoveryTitle("install-service", "linux")).toBe("Your Server Isn't Installed as a Service");
    expect(recoveryTitle("start", "darwin")).toBe("Your Server Is Stopped");
  });

  it("says this Mac on darwin and this machine everywhere else", () => {
    expect(recoveryTitle("setup", "darwin")).toBe("Set Up Subshell on this Mac");
    expect(recoveryTitle("setup", "linux")).toBe("Set Up Subshell on this machine");
  });

  it("offers one primary action per step", () => {
    expect(recoveryAction("start")).toEqual({ label: "Start", kind: "start" });
    expect(recoveryAction("install-service")).toEqual({ label: "Install and Start", kind: "install-service" });
    expect(recoveryAction("init")).toEqual({ label: "Set Up", kind: "setup" });
    expect(recoveryAction("unreachable")).toEqual({ label: "Retry", kind: "retry" });
    expect(recoveryAction("no-server")).toEqual({ label: "Choose subshell-server…", kind: "choose-binary" });
    expect(recoveryAction("setup")).toEqual({ label: "Set Up", kind: "setup" });
  });

  it("offers nothing on ready — the screen is already leaving", () => {
    expect(recoveryAction("ready")).toBeNull();
  });
});

describe("dots", () => {
  it("always has six positions, so the row does not grow when the SPA takes over", () =>
    expect(dots(virgin(), "welcome").total).toBe(6));
  it("counts a skipped tmux screen as done", () => {
    expect(dots(virgin(WITH_TMUX), "setup")).toEqual({ total: 6, done: 2, current: 2 });
    expect(dots(virgin(WITH_TMUX), "welcome")).toEqual({ total: 6, done: 0, current: 0 });
  });
  it("walks the three when tmux is missing", () => {
    expect(dots(virgin(), "tmux")).toEqual({ total: 6, done: 1, current: 1 });
    expect(dots(virgin(), "setup")).toEqual({ total: 6, done: 2, current: 2 });
  });
  it("has no position at all for the screens outside the first run", () => {
    // Recovery, Update and Reset are not steps on a journey, so the row is
    // hidden rather than shown with nothing filled. A negative `current` is
    // what the renderer hides on.
    for (const screen of ["recovery", "update", "reset"] as const) {
      expect(dots(virgin(), screen)).toEqual({ total: 6, done: -1, current: -1 });
    }
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
