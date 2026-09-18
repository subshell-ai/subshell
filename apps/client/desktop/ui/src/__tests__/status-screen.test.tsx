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
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
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
function makeCommands(calls: Call[]): NodeCommands {
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
    installAgent: rec("installAgent"),
    updateAgent: rec("updateAgent"),
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
      commands={makeCommands(calls)}
      busy={init.busy ?? false}
      onRegister={() => pressed.push("register")}
      onReenroll={() => pressed.push("reenroll")}
      onReset={() => pressed.push("reset")}
      onCheckAppUpdate={() => pressed.push("app-update")}
    />,
  );
  return { calls, pressed };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const maybeButton = (name: string | RegExp) => screen.queryByRole("button", { name });

describe("an enrolled, online machine", () => {
  it("offers the dashboard and the way back out, and nothing about registering", () => {
    mount();
    expect(button(/open dashboard/i)).toBeTruthy();
    expect(button(/unregister this machine/i)).toBeTruthy();
    expect(maybeButton(/^register this machine$/i)).toBeNull();
  });

  /**
   * `null` is the whole contract: the Rust side re-reads its own address
   * ladder, so the button opens what this app is configured for rather than
   * whatever string the page happened to be holding.
   */
  it("opens the plane with no URL of its own", () => {
    const { calls } = mount();
    fireEvent.click(button(/open dashboard/i));
    expect(calls).toEqual([{ name: "openPlane", args: [null] }]);
  });

  /** The node's name is a fact only when THIS session chose it (probe-facts.ts). */
  it("says the name it enrolled under when this session knows it", () => {
    mount({ enrolledNode: { nodeId: makeProbe().status?.nodeId ?? "", name: "mac mini" } });
    expect(screen.getByText("mac mini")).toBeTruthy();
  });

  it("unregisters through the reset flow", () => {
    const { pressed } = mount();
    fireEvent.click(button(/unregister this machine/i));
    expect(pressed).toEqual(["reset"]);
  });

  /** Nothing is wrong with this machine, so no service verb is offered. */
  it("offers no service action", () => {
    mount();
    expect(maybeButton(/^(start|restart|install and start)$/i)).toBeNull();
  });
});

describe("the address the primary button will open", () => {
  /**
   * The button says only "Open Dashboard", so which server that is has to be
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
  it("offers the dashboard and Register, and never Unregister", () => {
    mount({ probe: watcherProbe() });
    expect(button(/open dashboard/i)).toBeTruthy();
    expect(button(/^register this machine$/i)).toBeTruthy();
    expect(maybeButton(/unregister this machine/i)).toBeNull();
  });

  it("starts the registration flow", () => {
    const { pressed } = mount({ probe: watcherProbe() });
    fireEvent.click(button(/^register this machine$/i));
    expect(pressed).toEqual(["register"]);
  });

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

  it("still says which server this app opens", () => {
    mount({ probe: watcherProbe(), settings: makeSettings({ planeUrl: "https://watch.example" }) });
    expect(screen.getAllByText("https://watch.example").length).toBeGreaterThan(0);
  });
});

describe("a node whose agent is not running", () => {
  const stopped = makeProbe({ step: "stopped", service: { ...makeProbe().service, state: "stopped", pid: null } });

  it("offers Start, and says what is wrong", () => {
    const { calls } = mount({ probe: stopped });
    expect(screen.getByText(/the agent is not running/i)).toBeTruthy();
    fireEvent.click(button(/^start$/i));
    expect(calls).toEqual([{ name: "service", args: ["start", { settle: true }] }]);
  });

  /** Restart is the two-phase command: its refusal is read before `--force`. */
  it("offers Restart for an offline node, through the confirming path", () => {
    const { calls } = mount({ probe: makeProbe({ step: "offline" }) });
    fireEvent.click(button(/^restart$/i));
    expect(calls).toEqual([{ name: "restart", args: [] }]);
  });

  it("offers Install and Start when nothing keeps the agent running", () => {
    mount({ probe: makeProbe({ step: "no-service", service: { installed: false } }) });
    expect(button(/^install and start$/i)).toBeTruthy();
  });

  /** A landing screen is not a dead end, and it is not a detour either. */
  it("still offers the dashboard", () => {
    mount({ probe: stopped });
    expect(button(/open dashboard/i)).toBeTruthy();
  });

  /**
   * tmux is a gate, not a caption: a node that starts without it comes up
   * online with no harnesses and refuses every launch.
   */
  it("disables the service action while tmux is missing, and says why", () => {
    mount({ probe: makeProbe({ step: "stopped", tmux: null }) });
    expect(button(/^start$/i).disabled).toBe(true);
    expect(screen.getByText(/tmux was not found/i)).toBeTruthy();
  });
});

describe("the two control-plane addresses", () => {
  /** Enrolled against one plane, with the app pointed at another. */
  const diverged = { probe: makeProbe(), settings: makeSettings({ planeUrl: "https://elsewhere.example" }) };

  it("names both when they disagree, and offers the reconciliation", () => {
    const { calls } = mount(diverged);
    const notice = screen.getByRole("status", { name: /mismatch/i });
    expect(notice.textContent).toContain("https://elsewhere.example");
    expect(notice.textContent).toContain("https://subshell.example.com");
    fireEvent.click(within(notice).getByRole("button", { name: /use https:\/\/elsewhere\.example/i }));
    expect(calls).toEqual([{ name: "repoint", args: ["https://elsewhere.example"] }]);
  });

  it("says nothing when the two agree", () => {
    mount();
    expect(screen.queryByRole("status", { name: /mismatch/i })).toBeNull();
  });

  it("flags a loopback node address without refusing anything", () => {
    mount({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    expect(screen.getByRole("status", { name: /loopback/i }).textContent).toMatch(/this machine/i);
    expect(button(/repoint this node/i)).toBeTruthy();
  });
});

describe("what the connected screen offered is still offered", () => {
  it("keeps Change server…, Open in browser instead and Check for app updates…", () => {
    const { calls, pressed } = mount();
    expect(button(/change server/i)).toBeTruthy();
    fireEvent.click(button(/open in browser instead/i));
    expect(calls).toEqual([{ name: "openPlaneUrl", args: [] }]);
    fireEvent.click(button(/check for app updates/i));
    expect(pressed).toEqual(["app-update"]);
  });

  it("keeps Re-enroll… for a machine that is one", () => {
    const { pressed } = mount();
    fireEvent.click(button(/re-enroll/i));
    expect(pressed).toEqual(["reenroll"]);
  });

  it("offers the bundled agent when it is newer", () => {
    const { calls } = mount({ probe: makeProbe({ agentChoice: "upgrade-available", bundledVersion: "2.0.0" }) });
    fireEvent.click(button(/update the agent to 2\.0\.0/i));
    expect(calls).toEqual([{ name: "updateAgent", args: [] }]);
  });

  /** The remedy the restart refusal names BY LABEL, so the label is pinned. */
  it("offers the definition rewrite when a teardown would kill live panes", () => {
    const { calls } = mount({
      probe: makeProbe({ service: { ...makeProbe().service, paneSafety: "kills" } }),
    });
    fireEvent.click(button(/rewrite the service definition/i));
    expect(calls).toEqual([{ name: "rewrite", args: [] }]);
  });

  it("keeps the facts and the CLI's last words behind Show Details", () => {
    mount();
    expect(screen.getByText("Show Details")).toBeTruthy();
  });

  it("lets a stuck machine be re-read", () => {
    const { calls } = mount({ probe: makeProbe({ step: "stopped" }) });
    fireEvent.click(button(/^refresh$/i));
    expect(calls).toEqual([{ name: "refresh", args: [] }]);
  });
});
