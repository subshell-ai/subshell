/**
 * `route()` — the pure routing the old `render()` did inline, ported from
 * `wizard.ts`'s dispatch (probe null, requested screens, the empty-list
 * handoff, and the resolve/correct step over `screensFor`'s list), and
 * `nextPollDelay()` — the poll's gate, ported from `tick()`'s skip.
 */
import { describe, expect, it } from "bun:test";
import type { ActionResult, Probe } from "../ipc";
import { nextPollDelay, RAIL_SECTIONS, railActive, railFor, resolveJourney, route } from "../server-state";

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

  // The reset request left the routing on 2026-09-23: the rail's door and the
  // dashboard's deep link both open a DIALOG over the standing section
  // (`resetOpen` host state), so `route()` never sees a reset and the section
  // underneath keeps its kind. What the old gate protected — the dialog
  // showing before the plan arms, and the ready handoff not opening the
  // dashboard out from under it — is pinned in `host.test.tsx`.

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

  it("routes the ready handoff when the list is empty, the screen is null, and nothing runs", () => {
    // Arrival is the handoff's case: a window opened (or reopened) over a
    // running machine owes no result to a reader and hands off.
    expect(route(probe({ next: "ready", onboarded: true }), null, IDLE)).toEqual({ kind: "handoff" });
    // But a window STANDING on the Status section stays there (operator
    // ruling 2026-09-23). The rail's Status select sets `recovery` — the
    // standing marker, also what the ratchet's correction onto recovery
    // writes — and on a running machine that is the status screen with its
    // one button, not the handoff's bounce through the setup pane.
    expect(route(probe({ next: "ready", onboarded: true }), "recovery", IDLE)).toEqual({ kind: "status" });
    // But while a chain is still running it outranks even a standing Status
    // marker: the in-flight checklist renders, not the facts screen.
    expect(route(probe({ next: "ready" }), "recovery", { running: true, failure: null })).toEqual({ kind: "setup" });
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

describe("resolveJourney", () => {
  it("answers null on an empty list — the handoff's territory", () => {
    expect(resolveJourney(probe({ next: "ready", onboarded: true }), null)).toBeNull();
    expect(resolveJourney(probe({ next: "ready", onboarded: true }), "setup")).toBeNull();
  });

  it("resolves a null screen to the list's head", () => {
    expect(resolveJourney(probe({ onboarded: false, next: "init" }), null)).toBe("welcome");
  });

  it("returns a screen the list still offers, unchanged", () => {
    expect(resolveJourney(probe({ onboarded: false, next: "init" }), "setup")).toBe("setup");
  });

  it("corrects a stale screen past the welcome", () => {
    // THE tmux advance.
    expect(resolveJourney(probe({ onboarded: false, next: "init", tmux: "/usr/bin/tmux" }), "tmux")).toBe("setup");
    // And the freshly-onboarded correction onto recovery.
    expect(resolveJourney(probe({ onboarded: true, next: "start" }), "setup")).toBe("recovery");
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

/**
 * The rail's exclusion, as data (spec 2026-09-21; plan Task 10, with the
 * operator's 2026-09-22 ruling that the FTE never gets it). The rule is the
 * spec's sentence: the rail appears when the machine is onboarded and no
 * first-run step is in progress — so the FTE family, permissions and boot
 * answer null, and a STANDING route on a machine that is not onboarded
 * answers null too (the old page let a requested update render mid-FTE; wave
 * 2 renders it full-window, without the rail). Reset left the routing on
 * 2026-09-23: its rail door opens a dialog over the standing section, so
 * there is no reset kind for these functions to answer for — the rail is
 * always the section's own.
 */
describe("railFor", () => {
  it("answers null for every FTE family route, permissions and boot", () => {
    for (const kind of ["welcome", "tmux", "setup", "handoff", "permissions", "boot"] as const) {
      expect(railFor({ kind }, true), kind).toBeNull();
      expect(railFor({ kind }, false), kind).toBeNull();
    }
  });

  it("keeps the Reset door in every standing rail, danger-styled, and routes nothing", () => {
    // The door is still the rail's fifth section (ruling 2026-09-22); what
    // the 2026-09-23 dialog ruling took away is its ROUTE. There is no
    // `{ kind: "reset" }` for `railFor` or `railActive` to answer for: the
    // select opens the dialog over whatever section's rail this is, and that
    // section keeps the highlight while it is up.
    expect(RAIL_SECTIONS.find((s) => s.id === "reset")?.danger).toBe(true);
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(["status", "update", "supervision", "settings", "reset"]);
  });

  it("answers null for a standing route on a machine mid-first-run", () => {
    // The old page allowed a requested screen over any machine; wave 2 keeps
    // the render but takes away the rail — the exclusion stays absolute.
    for (const kind of ["status", "update", "supervision", "addresses"] as const) {
      expect(railFor({ kind }, false), kind).toBeNull();
    }
  });

  it("answers the five standing sections for a standing route on an onboarded machine", () => {
    // The fifth is Reset (operator ruling 2026-09-22): the DOOR in the rail,
    // marked destructive.
    const sections = railFor({ kind: "status" }, true);
    expect(sections?.map((s) => s.id)).toEqual(["status", "update", "supervision", "settings", "reset"]);
    expect(sections?.map((s) => s.label)).toEqual(["Status", "Update", "Service", "Addresses", "Reset"]);
    expect(sections?.find((s) => s.id === "reset")?.danger).toBe(true);
    for (const kind of ["update", "supervision", "addresses"] as const) {
      expect(railFor({ kind }, true)?.map((s) => s.id)).toEqual([
        "status",
        "update",
        "supervision",
        "settings",
        "reset",
      ]);
    }
  });

  it("marks the active section by the route, through railActive", () => {
    expect(railActive({ kind: "status" })).toBe("status");
    expect(railActive({ kind: "update" })).toBe("update");
    expect(railActive({ kind: "supervision" })).toBe("supervision");
    expect(railActive({ kind: "addresses" })).toBe("settings");
    // A route that gets no rail gets no active state either. The running
    // machine's status screen highlights Status like the diagnosis does —
    // same kind, one section. Reset is no longer a kind at all (the dialog
    // ruling of 2026-09-23): it never holds the highlight, because it never
    // leaves the section it opened over.
    expect(railActive({ kind: "handoff" })).toBeNull();
    expect(railActive({ kind: "welcome" })).toBeNull();
    expect(railActive({ kind: "boot" })).toBeNull();
  });
});
