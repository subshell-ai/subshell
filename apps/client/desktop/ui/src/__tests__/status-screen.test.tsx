/**
 * The landing screen a configured client returns to, and the rules IT carries.
 *
 * The door rulings (operator 2026-09-22): the control plane's window is opened
 * by nothing but a press, and since the second addendum this screen carries NO
 * door at all — the Control Plane section's Dashboard card owns both opens,
 * and the rail's Reset section is Unregister's only entry. So the cases here
 * are mostly absences, plus what survives them: the badge and the one
 * sentence adapt to whether this machine is a node, and the facts render
 * inline as Status's alone. There is no commands mock in this file because
 * there is nothing to mock: the screen takes no commands, and the "no button
 * at all" case is what makes that a pin rather than a habit.
 *
 * Rendered directly rather than through `App`: the routing that lands a client
 * here is `client-flow`'s, tested there, and this file is about what the
 * screen offers once it is reached.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { StatusScreen } from "@/components/assistant/status-screen";
import { subtitleFor } from "@/components/assistant/subtitles";
import type { EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);

const shell = { title: "This Machine", subtitle: "What this machine is doing." };

/** A probe of a machine that has never been registered — a client that only watches. */
function watcherProbe(overrides: Partial<Probe> = {}): Probe {
  return makeProbe({
    step: "not-enrolled",
    status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" },
    service: { installed: false },
    ...overrides,
  });
}

function mount(init: { probe?: Probe; settings?: NodeSettings; enrolledNode?: EnrolledNodeBody | null } = {}) {
  renderApp(
    <StatusScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      settings={init.settings ?? makeSettings()}
      enrolledNode={init.enrolledNode ?? null}
    />,
  );
}

const maybeButton = (name: string | RegExp) => screen.queryByRole("button", { name });

describe("an enrolled, online machine", () => {
  it("offers NO door, and nothing about registering or unregistering", () => {
    // The door rulings (operator 2026-09-22; the second addendum superseded
    // the same day's browser ghost): anything that opens the control plane —
    // in the app or in the system browser — lives on the Control Plane
    // section's Dashboard card. Unregister is NOT a link here either: the
    // rail's Reset section is that door, and one act with two labels is two
    // acts to a reader.
    mount();
    expect(maybeButton(/open dashboard/i)).toBeNull();
    expect(maybeButton(/open in browser/i)).toBeNull();
    expect(maybeButton(/open in app/i)).toBeNull();
    expect(maybeButton(/unregister this machine/i)).toBeNull();
    expect(maybeButton(/^register this machine$/i)).toBeNull();
  });

  /** The node's name is a fact only when THIS session chose it (probe-facts.ts). */
  it("says the name it enrolled under when this session knows it", () => {
    mount({ enrolledNode: { nodeId: makeProbe().status?.nodeId ?? "", name: "mac mini" } });
    expect(screen.getByText("mac mini")).toBeTruthy();
  });

  /** Nothing is wrong with this machine, so no service verb is offered. */
  it("offers no service action", () => {
    mount();
    expect(maybeButton(/^(start|restart|install and start)$/i)).toBeNull();
  });

  // The ONE-Entry ruling stated as its own pin (operator ruling 2026-09-22,
  // fix wave): the rail's Reset section is Unregister's only entry, and
  // "only" is testable here — not just no button or link NAMED Unregister,
  // but no button at all, since any button on this screen would be an act
  // the screen is not allowed to offer.
  it("offers no second Unregister entry, and no button at all", () => {
    mount();
    expect(screen.queryByRole("button", { name: /unregister/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /unregister/i })).toBeNull();
    expect(screen.queryByText(/unregister/i)).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("the address the doors will open", () => {
  /**
   * The doors say only "Open in browser", so which server that is has to be
   * on the face of the screen — and it is, in the SUBTITLE, in both branches.
   * The screen used to repeat it in a "Dashboard <url>" line under the badge,
   * which is the redundancy this replaced. `mount` supplies its own fixed
   * shell subtitle, so this asks the function `app.tsx` builds the real one
   * with rather than the rendered screen.
   */
  it("is named by the subtitle whether or not this machine is a node", () => {
    const settings = makeSettings({ planeUrl: "https://plane.example" });
    expect(subtitleFor("status", makeProbe(), settings)).toContain("https://plane.example");
    expect(subtitleFor("status", watcherProbe(), settings)).toContain("https://plane.example");
    // And with no stored preference, the node's own address is what the
    // button's ladder falls back to — so that is what the sentence names.
    expect(subtitleFor("status", makeProbe(), makeSettings({ planeUrl: null }))).toContain(
      "https://subshell.example.com",
    );
  });
});

describe("a client that is not a node", () => {
  /**
   * Re-enrolling is what you do to a machine that IS one; on this machine the
   * act with that meaning is Register, and two labels for one thing is two
   * things to a reader.
   */
  it("does not offer Re-enroll", () => {
    mount({ probe: watcherProbe() });
    expect(maybeButton(/re-enroll/i)).toBeNull();
  });

  /** There is no node address to repoint — the node block is the node's. */
  it("does not offer to repoint anything", () => {
    mount({ probe: watcherProbe() });
    expect(maybeButton(/repoint this node/i)).toBeNull();
  });

  it("says what the machine is, not which server it opens", () => {
    // The status screen keeps machine state (operator ruling 2026-09-22);
    // the plane address is the Control Plane section's, shown labeled there,
    // and the "This app opens <url>" narration is gone.
    mount({ probe: watcherProbe(), settings: makeSettings({ planeUrl: "https://watch.example" }) });
    expect(screen.queryByText(/this app opens/i)).toBeNull();
  });
});

// The service verb cards moved to the Service section (operator ruling
// 2026-09-22); their screen-level pins live in service-screen.test.tsx now.

// The plane addresses moved to the Control Plane section (operator ruling
// 2026-09-22); their screen-level pins live in plane-screen.test.tsx now.

describe("what the connected screen offered is still offered", () => {
  it("offers neither the plane doors nor the update door — the rail and the Control Plane section carry them", () => {
    // The plane address's home is the Control Plane section and the update
    // door is the rail's Update section (operator rulings, 2026-09-22); the
    // status screen keeps machine state and the two machine acts.
    mount();
    expect(maybeButton(/change server/i)).toBeNull();
    expect(maybeButton(/open the control plane/i)).toBeNull();
    // No doors at all after the second addendum: the Control Plane section's
    // Dashboard card is the only place that opens the plane.
    expect(maybeButton(/open in browser/i)).toBeNull();
    expect(maybeButton(/open in app/i)).toBeNull();
    expect(maybeButton(/open dashboard/i)).toBeNull();
    expect(maybeButton(/check for updates/i)).toBeNull();
    expect(maybeButton(/update the node to/i)).toBeNull();
  });

  it("offers no Re-enroll even on a machine that is one — the act is the Control Plane section's", () => {
    // Operator ruling 2026-09-22: re-enrolling is an act on this machine's
    // RELATIONSHIP to the plane, so it moved out of the machine-state screen.
    // The Control Plane side of the move is pinned in plane-screen.test.tsx.
    mount();
    expect(maybeButton(/re-enroll/i)).toBeNull();
  });

  it("renders the facts INLINE, and they are this screen's alone", () => {
    // Operator ruling 2026-09-22 (the server wave's ruling carried over): a
    // section that hides its own facts behind a second control is two
    // navigations for one answer. And since screenshot 60 the list is THIS
    // screen's ALONE — every other screen lost it — so the full list
    // including `bundled` and `tmux` lives here again (superseding the
    // screenshot-52 scoping).
    mount();
    expect(screen.queryByText("Show Details")).toBeNull();
    expect(screen.getByText("/usr/bin/tmux")).toBeTruthy();
    expect(screen.getByText("/home/u/.config/subshell/config.json")).toBeTruthy();
  });

  it("offers no refresh — the probe's own interval re-reads the machine", () => {
    // Operator ruling 2026-09-22: no Refresh button; the poll is the refresh.
    // The interval wiring itself is pinned in `use-node-state.test.tsx`.
    mount({ probe: makeProbe({ step: "stopped" }) });
    expect(maybeButton(/^refresh$/i)).toBeNull();
  });
});
