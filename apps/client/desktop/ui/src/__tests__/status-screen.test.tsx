/**
 * The landing screen a configured client returns to, and the rules IT carries.
 *
 * The door rulings (operator 2026-09-22): the control plane's window is opened
 * by nothing but a press, and since the second addendum this screen carries NO
 * door at all — the Control Plane section's Dashboard card owns both opens,
 * and the rail's Reset section is Unregister's only entry. So the cases here
 * are mostly absences, plus what survives them: the badge and the one
 * sentence adapt to whether this machine is a node, and the facts render
 * inline as Status's alone. The rails final addendum (2026-09-22) narrowed
 * "no button at all" to its truth: the screen offers no ACT, and the fact
 * rows' inline Reveals are not acts — they open the fact the row is already
 * showing, exactly the server's pattern — so the pin is that NOTHING else is
 * a button. The log tail renders what the host fed; the feeding rule itself
 * is pinned in `app.test.tsx`.
 *
 * Rendered directly rather than through `App`: the routing that lands a client
 * here is `client-flow`'s, tested there, and this file is about what the
 * screen offers once it is reached.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { StatusScreen } from "@/components/assistant/status-screen";
import { subtitleFor } from "@/components/assistant/subtitles";
import type { EnrolledNodeBody, LogTail, NodeSettings, OpenTarget, Probe } from "@/lib/ipc";
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

function mount(
  init: {
    probe?: Probe;
    settings?: NodeSettings;
    enrolledNode?: EnrolledNodeBody | null;
    nodeLog?: LogTail | null;
  } = {},
) {
  const revealed: OpenTarget[] = [];
  renderApp(
    <StatusScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      settings={init.settings ?? makeSettings()}
      enrolledNode={init.enrolledNode ?? null}
      nodeLog={init.nodeLog ?? null}
      onReveal={(target) => revealed.push(target)}
    />,
  );
  return { revealed };
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
  // "only" is testable here. The rails final addendum (2026-09-22) narrowed
  // the strict form of that pin — "no button at all" — to its truth: no ACT.
  // The fact rows' inline Reveals are the one exception the server's Status
  // section always had, so the pin is that NOTHING besides a Reveal is a
  // button: the default fixture is the Linux shape, where the log row shows
  // a hint (no file to reveal) and the config row shows one.
  it("offers no second Unregister entry, and no button but the facts' Reveals", () => {
    mount();
    expect(screen.queryByRole("button", { name: /unregister/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /unregister/i })).toBeNull();
    expect(screen.queryByText(/unregister/i)).toBeNull();
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).toEqual(["Reveal"]);
  });

  it("reveals by intent, from the row whose fact it opens", () => {
    // Intent, never a path (the server's pattern): the page hands Rust the
    // NAME of the target and Rust re-reads the path from its own probe.
    const { revealed } = mount({
      probe: makeProbe({
        paths: {
          configDir: "/home/u/.config/subshell",
          configFile: "/home/u/.config/subshell/config.json",
          dataDir: "/home/u/.config/subshell/data",
          nodeLog: "/home/u/.local/state/subshell/daemon.log",
          nodeLogHint: null,
        },
      }),
    });
    const reveals = screen.getAllByRole("button", { name: /^reveal$/i });
    expect(reveals).toHaveLength(2);
    fireEvent.click(reveals[0]);
    fireEvent.click(reveals[1]);
    expect(revealed).toEqual(["config-dir", "node-log"]);
  });

  it("renders the node log tail, and its note when nothing has been written", () => {
    mount({ nodeLog: { text: "", source: "the node's log", note: "nothing has been written yet" } });
    expect(screen.getByText("Node log")).toBeTruthy();
    expect(screen.getByText("nothing has been written yet")).toBeTruthy();
  });

  it("renders the tail's own lines", () => {
    mount({ nodeLog: { text: "09:14:02 INFO daemon up\n09:15:10 WARN heartbeat late\n", source: "x", note: null } });
    expect(screen.getByText(/09:14:02 INFO daemon up/)).toBeTruthy();
    expect(screen.getByText(/09:15:10 WARN heartbeat late/)).toBeTruthy();
  });

  it("shows the pane before the first read lands", () => {
    mount({ nodeLog: null });
    expect(screen.getByText("Node log")).toBeTruthy();
  });
});

describe("the status subtitle", () => {
  /**
   * The plane list took the doors off this screen, so the subtitle states
   * the MACHINE: a node names the plane it reports to, and a watcher names
   * no address at all, because the list holds many and none is current.
   * `mount` supplies its own fixed shell subtitle, so this asks the function
   * `app.tsx` builds the real one with rather than the rendered screen.
   */
  it("names the node's own address, and no address for a watcher", () => {
    const settings = makeSettings({ planes: ["https://plane.example"] });
    // An app bookmark cannot outrank where this machine's node reports.
    const nodeLine = subtitleFor("status", makeProbe(), settings);
    expect(nodeLine).toContain("https://subshell.example.com");
    expect(nodeLine).not.toContain("https://plane.example");
    expect(subtitleFor("status", watcherProbe(), settings)).toBe("This machine is not a node.");
    // First probe still in flight: nothing is claimed yet.
    expect(subtitleFor("status", undefined, settings)).toBeUndefined();
  });
});

describe("a client that is not a node", () => {
  it("says what the machine is, not which server it opens", () => {
    // The status screen keeps machine state (operator ruling 2026-09-22);
    // the plane address is the Control Plane section's, shown labeled there,
    // and the "This app opens <url>" narration is gone.
    mount({ probe: watcherProbe(), settings: makeSettings({ planes: ["https://watch.example"] }) });
    expect(screen.queryByText(/this app opens/i)).toBeNull();
  });
});

// The service verb cards moved to the Service section (operator ruling
// 2026-09-22); their screen-level pins live in service-screen.test.tsx now.

// The plane addresses moved to the Control Plane section (operator ruling
// 2026-09-22); their screen-level pins live in plane-screen.test.tsx now.
