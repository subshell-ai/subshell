/**
 * The landing screen for a configured client, and the rule it carries.
 *
 * Spec 2026-09-18 § 2: the control plane's window is never opened by anything
 * but a press, so this screen's primary button is the only route to it — and
 * every state a configured machine can be in has to land here and still have
 * somewhere to go. The cases below are those two properties: the dashboard
 * button is present and calls the command that opens it, and the screen adapts
 * to whether this machine is a node (Unregister) or merely watching one
 * (Register) and to whether its agent is actually running.
 *
 * Rendered directly rather than through `App`: the routing that lands a client
 * here is `node-assistant-state`'s, tested there, and this file is about what
 * the screen offers once it is reached.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { StatusScreen } from "@/components/assistant/status-screen";
import { subtitleFor } from "@/components/assistant/subtitles";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);

/** One recorded command call. */
interface Call {
  name: string;
  args: unknown[];
}

/**
 * A `NodeCommands` that records instead of invoking.
 *
 * Every member, spelled out: the screen decides which ones to offer, so a
 * command that becomes reachable later fails loudly here rather than being
 * silently undefined.
 */
function _makeCommands(calls: Call[]): NodeCommands {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      // Argument-less commands are handed straight to `onClick`, exactly as
      // the connected screen hands them, so React passes each one its click
      // event. The real commands ignore it; recording it would make every
      // assertion here a comparison against a synthetic event, so only VALUES
      // are kept — a primitive, `null`, or a plain options object.
      const kept = args.filter(
        (a) => a === null || typeof a !== "object" || Object.getPrototypeOf(a) === Object.prototype,
      );
      calls.push({ name, args: kept });
    };
  return {
    refresh: rec("refresh"),
    installNode: rec("installNode"),
    updateNode: rec("updateNode"),
    service: rec("service"),
    restart: rec("restart"),
    uninstall: rec("uninstall"),
    rewrite: rec("rewrite"),
    enroll: rec("enroll"),
    repoint: rec("repoint"),
    openPath: rec("openPath"),
    openPlane: rec("openPlane"),
    openPlaneUrl: rec("openPlaneUrl"),
    // The first-run commands. This screen never invokes them — it is the
    // landing a configured client returns to — but the mock stands in for the
    // whole interface, so leaving them out would fail the build rather than
    // any assertion here.
    installTmux: rec("installTmux"),
    connectOnly: rec("connectOnly"),
    register: rec("register"),
  };
}

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

function mount(
  init: { probe?: Probe; settings?: NodeSettings; enrolledNode?: EnrolledNodeBody | null; busy?: boolean } = {},
) {
  const calls: Call[] = [];
  const pressed: string[] = [];
  renderApp(
    <StatusScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      settings={init.settings ?? makeSettings()}
      enrolledNode={init.enrolledNode ?? null}
      output={null}
      busy={init.busy ?? false}
    />,
  );
  return { calls, pressed };
}

const _button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const maybeButton = (name: string | RegExp) => screen.queryByRole("button", { name });
const buttonOrNull_ = maybeButton;

describe("an enrolled, online machine", () => {
  it("offers NO door, and nothing about registering or unregistering", () => {
    // The door rulings (operator 2026-09-22; the second addendum superseded
    // the same day's browser ghost): anything that opens the control plane —
    // in the app or in the system browser — lives on the Control Plane
    // section's Dashboard card. Unregister is NOT a link here either: the
    // rail's Reset section is that door, and one act with two labels is two
    // acts to a reader.
    const { calls } = mount();
    expect(maybeButton(/open dashboard/i)).toBeNull();
    expect(maybeButton(/open in browser/i)).toBeNull();
    expect(maybeButton(/open in app/i)).toBeNull();
    expect(maybeButton(/unregister this machine/i)).toBeNull();
    expect(maybeButton(/^register this machine$/i)).toBeNull();
    expect(calls).toEqual([]);
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
    expect(buttonOrNull_(/change server/i)).toBeNull();
    expect(buttonOrNull_(/open the control plane/i)).toBeNull();
    // No doors at all after the second addendum: the Control Plane section's
    // Dashboard card is the only place that opens the plane.
    expect(buttonOrNull_(/open in browser/i)).toBeNull();
    expect(buttonOrNull_(/open in app/i)).toBeNull();
    expect(buttonOrNull_(/open dashboard/i)).toBeNull();
    expect(buttonOrNull_(/check for updates/i)).toBeNull();
    expect(buttonOrNull_(/update the node to/i)).toBeNull();
  });

  it("offers no Re-enroll even on a machine that is one — the act is the Control Plane section's", () => {
    // Operator ruling 2026-09-22: re-enrolling is an act on this machine's
    // RELATIONSHIP to the plane, so it moved out of the machine-state screen.
    // The Control Plane side of the move is pinned in plane-screen.test.tsx.
    const { pressed } = mount();
    expect(buttonOrNull_(/re-enroll/i)).toBeNull();
    expect(pressed).toEqual([]);
  });

  /**
   * Still ANNOUNCED here, and no longer INSTALLED from here (spec 2026-09-18
   * § 7.4). This app ships the agent, so a machine whose bundled agent is
   * newer usually has a newer app waiting too, and installing one half on the
   * spot is what produced the loop where the next launch asked again. The
   * button is a door to the one update screen, which then does whichever
   * halves are actually behind.
   */
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
    const { calls } = mount({ probe: makeProbe({ step: "stopped" }) });
    expect(buttonOrNull_(/^refresh$/i)).toBeNull();
    expect(calls).toEqual([]);
  });
});
