/**
 * `route()` — the pure routing the old `render()` did inline, ported from
 * `wizard.ts`'s dispatch (probe null, requested screens, the empty-list
 * handoff, and the resolve/correct step over `screensFor`'s list), and
 * `nextPollDelay()` — the poll's gate, ported from `tick()`'s skip.
 */
import { describe, expect, it } from "bun:test";
import type { ActionResult, Probe } from "../ipc";
import { nextPollDelay, route } from "../server-state";

/** A minimal probe, shaped up per test with only what the routing reads. */
function probe(over: Partial<Probe>): Probe {
  return {
    bundledVersion: "0.12.1",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "start",
    error: null,
    tmux: "/opt/homebrew/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: true,
    hostname: "testhost",
    supervision: "service",
    supervisor: null,
    notificationPermission: "authorized",
    photosPermission: "authorized",
    pendingInstall: null,
    ...over,
  };
}

const RUNNING = { running: true, failure: null as ActionResult | null };
const IDLE = { running: false, failure: null as ActionResult | null };

describe("route", () => {
  it("answers boot while the probe is still landing", () => {
    expect(route(null, null, IDLE)).toEqual({ kind: "boot" });
    // A screen named from outside cannot outperform a probe that is not there
    // yet — the old render checked `probe === null` before anything else that
    // reads it, because a requested screen drawn against `probe === null`
    // would render refusals for facts it has not read.
    expect(route(null, "update", IDLE)).toEqual({ kind: "boot" });
  });

  it("routes the reset request to the reset screen, even before the probe", () => {
    // `openReset` sets `screen` before it arms the plan, and the old render's
    // reset gate ran before the probe check — the screen is what explains a
    // refusal, so it shows with or without facts.
    expect(route(probe({}), "reset", IDLE)).toEqual({ kind: "reset" });
    expect(route(null, "reset", IDLE)).toEqual({ kind: "reset" });
  });

  it("lets a requested screen outrank everything the probe implies", () => {
    // On a READY machine (screensFor answers empty) a requested screen is the
    // only thing that keeps the window from handing off — Update deep-links
    // onto a running server, and without this rule the ready probe would
    // close it the moment the next poll rendered.
    expect(route(probe({ next: "ready" }), "update", IDLE)).toEqual({ kind: "update" });
    expect(route(probe({ next: "ready" }), "supervision", IDLE)).toEqual({ kind: "supervision" });
    expect(route(probe({ next: "ready" }), "permissions", IDLE)).toEqual({ kind: "permissions" });
    // `settings` is Server Addresses on the route: the id keeps the wire word,
    // the screen keeps its own name.
    expect(route(probe({ next: "ready" }), "settings", IDLE)).toEqual({ kind: "addresses" });
    // The request outranks even a probe the machine is failing — the SPA
    // deep-links Update onto a machine whose server is down.
    expect(route(probe({ next: "unreachable", error: "connection refused" }), "update", IDLE)).toEqual({
      kind: "update",
    });
  });

  it("holds the setup screen while the chain runs, ready probe or not", () => {
    // The progress screen owns the window while `running`, even though the
    // machine's probe may already answer ready — the port binds before
    // startSetup's finally records the end of the chain.
    expect(route(probe({ next: "ready", onboarded: true }), null, RUNNING)).toEqual({ kind: "setup" });
    expect(route(probe({ next: "ready", onboarded: true }), "setup", RUNNING)).toEqual({ kind: "setup" });
  });

  it("routes the ready handoff when the list is empty and nothing runs", () => {
    expect(route(probe({ next: "ready", onboarded: true }), null, IDLE)).toEqual({ kind: "handoff" });
    // Onboarded and broken, then fixed: the recovery family's list is
    // ["recovery"], and a machine whose server came back empties it.
    expect(route(probe({ next: "ready" }), "recovery", IDLE)).toEqual({ kind: "handoff" });
  });

  it("lands a fresh machine on the welcome screen", () => {
    // tmux present: the list is [welcome, setup].
    expect(route(probe({ onboarded: false, next: "init" }), null, IDLE)).toEqual({ kind: "welcome" });
  });

  it("greets a fresh machine first, and keeps the tmux stop behind the press", () => {
    // tmux missing: the list is [welcome, tmux], and a null screen resolves
    // to its head — the greeting PRECEDES the journey; the tmux stop is what
    // the welcome's Continue steps to, and the screen the press set stays
    // while the probe still offers it.
    expect(route(probe({ onboarded: false, next: "init", tmux: null }), null, IDLE)).toEqual({ kind: "welcome" });
    expect(route(probe({ onboarded: false, next: "init", tmux: null }), "tmux", IDLE)).toEqual({ kind: "tmux" });
  });

  it("corrects a screen the probe no longer offers, past the welcome", () => {
    // THE tmux advance: the reader pressed past the welcome, tmux was found,
    // and the list dropped `tmux` — so the render walks to the act. The
    // correction skips `welcome` rather than greeting them again.
    expect(route(probe({ onboarded: false, next: "init", tmux: "/usr/bin/tmux" }), "tmux", IDLE)).toEqual({
      kind: "setup",
    });
    // Same mechanism on the recovery side: a machine that finished its first
    // run becomes onboarded, and "setup" is not on the recovery list.
    expect(route(probe({ onboarded: true, next: "start" }), "setup", IDLE)).toEqual({ kind: "status" });
    // A requested screen is NEVER corrected onto the journey: the old render
    // returned inside its requested arm, and "no screen is BOTH requestable
    // and a journey step, so the request alone routes". Even mid-first-run,
    // a named `settings` shows the address form.
    expect(route(probe({ onboarded: false, next: "init", tmux: null }), "settings", IDLE)).toEqual({
      kind: "addresses",
    });
  });

  it("renders the recovery screen for an onboarded, not-ready machine", () => {
    expect(route(probe({ onboarded: true, next: "start" }), null, IDLE)).toEqual({ kind: "status" });
    expect(route(probe({ onboarded: true, next: "unreachable" }), "recovery", IDLE)).toEqual({ kind: "status" });
  });

  it("keeps the screen the user navigated to while the probe still offers it", () => {
    // `go("setup")` set `screen`; the list still holds it; the render keeps it.
    expect(route(probe({ onboarded: false, next: "init" }), "setup", IDLE)).toEqual({ kind: "setup" });
    expect(route(probe({ onboarded: false, next: "init" }), "welcome", IDLE)).toEqual({ kind: "welcome" });
  });
});

describe("nextPollDelay", () => {
  it("polls every 1500 ms while the machine is quiet and visible", () => {
    expect(nextPollDelay({ busy: false, running: false, hidden: false })).toBe(1500);
  });

  it("holds the poll off while an action is in flight — unless the chain runs", () => {
    // `tick`'s own skip: a refresh under a running action is what it exists
    // to avoid. The setup chain is the exception — the poll must not stop
    // for that, because the progress checklist reads the probe.
    expect(nextPollDelay({ busy: true, running: false, hidden: false })).toBeNull();
    expect(nextPollDelay({ busy: true, running: true, hidden: false })).toBe(1500);
  });

  it("holds the poll off while the window is hidden — unless the chain runs", () => {
    expect(nextPollDelay({ busy: false, running: false, hidden: true })).toBeNull();
    expect(nextPollDelay({ busy: false, running: true, hidden: true })).toBe(1500);
  });
});
