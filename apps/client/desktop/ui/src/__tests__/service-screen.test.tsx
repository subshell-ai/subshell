/**
 * The Service section, as component tests — the node's own machinery, moved
 * out of the status screen by operator ruling 2026-09-22 (the rail's Service
 * section), and brought to the server's Service parity by the same day's
 * addendum: the arrangement stated, the run-at-login switch under it, the
 * lifecycle verbs for an installed service, the install-service door for a
 * machine whose node is unsupervised, and NO reveal bar (Status's facts carry
 * the paths). The install/no-node split and the unrecognised step are pinned
 * at the app level, where the whole page is under test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ServiceScreen } from "@/components/assistant/service-screen";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, ServiceStatusBody } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);

/** One recorded command call, values kept the way the status screen's does. */
interface Call {
  name: string;
  args: unknown[];
}

function makeCommands(calls: Call[]): NodeCommands {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
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
    autostart: rec("autostart"),
    rewrite: rec("rewrite"),
    enroll: rec("enroll"),
    repoint: rec("repoint"),
    openPath: rec("openPath"),
    openPlane: rec("openPlane"),
    openPlaneUrl: rec("openPlaneUrl"),
    installTmux: rec("installTmux"),
    connectOnly: rec("connectOnly"),
    register: rec("register"),
  };
}

const shell = { title: "Service", subtitle: "The node is the small program.", problem: "" };

function mount(init: { probe?: ReturnType<typeof makeProbe>; busy?: boolean } = {}) {
  const calls: Call[] = [];
  const pressed: string[] = [];
  renderApp(
    <ServiceScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      commands={makeCommands(calls)}
      busy={init.busy ?? false}
      onRegister={() => pressed.push("register")}
      output={null as ActionResult | null}
    />,
  );
  return { calls, pressed };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name });
const switchOrNull = () => screen.queryByRole("switch");

/** A service body with the given overrides on top of the healthy harness one. */
const service = (over: Partial<ServiceStatusBody>): ServiceStatusBody => ({ ...makeProbe().service, ...over });

describe("a node whose agent is not running", () => {
  const stopped = makeProbe({ step: "stopped", service: service({ state: "stopped", pid: null }) });

  it("offers Start inside the arrangement card, and says what is wrong", () => {
    const { calls } = mount({ probe: stopped });
    expect(screen.getByText(/the node is not running/i)).toBeTruthy();
    expect(screen.getByText("In the background")).toBeTruthy();
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
    const { calls } = mount({ probe: makeProbe({ step: "no-service", service: { installed: false } }) });
    fireEvent.click(button(/^install and start$/i));
    expect(calls).toEqual([{ name: "service", args: ["install", { settle: true }] }]);
  });

  /**
   * The addendum's door, stated as a gate: the install card is driven by the
   * DEFINITION, and an installed service never gets a second install offer
   * beside its own verbs.
   */
  it("shows the install offer only over a machine with no definition", () => {
    mount({ probe: makeProbe({ step: "no-service", service: { installed: false } }) });
    expect(button(/^install and start$/i)).toBeTruthy();
    expect(buttonOrNull(/^stop$/i)).toBeNull();
    cleanup();
    mount();
    expect(buttonOrNull(/^install and start$/i)).toBeNull();
    expect(screen.getByText("In the background")).toBeTruthy();
  });

  /**
   * tmux is a gate, not a caption: a node that starts without it comes up
   * online with no harnesses and refuses every launch. The verbs that START
   * things gate on it; Stop and Uninstall do not, because they cannot
   * manufacture that failure and a disabled one of those strands the box.
   */
  it("disables the starting verbs while tmux is missing, and says why", () => {
    mount({
      probe: makeProbe({ step: "stopped", tmux: null, service: service({ state: "stopped", pid: null }) }),
    });
    expect(button(/^start$/i).disabled).toBe(true);
    expect(button(/^uninstall$/i).disabled).toBe(false);
    expect(screen.getByText(/tmux was not found/i)).toBeTruthy();
  });

  it("keeps Stop live without tmux, over a running node", () => {
    mount({ probe: makeProbe({ tmux: null }) });
    expect(button(/^stop$/i).disabled).toBe(false);
    expect(button(/^restart$/i).disabled).toBe(true);
  });
});

/** The lifecycle verbs, for the installed service (server parity, addendum 2026-09-22). */
describe("the lifecycle of an installed service", () => {
  it("offers Stop, Restart and Uninstall over a running node, and no Start", () => {
    const { calls } = mount();
    expect(buttonOrNull(/^start$/i)).toBeNull();
    expect(button(/^stop$/i)).toBeTruthy();
    expect(button(/^restart$/i)).toBeTruthy();
    fireEvent.click(button(/^stop$/i));
    expect(calls).toEqual([{ name: "service", args: ["stop", { settle: true }] }]);
  });

  it("routes Uninstall through its confirmation command", () => {
    const { calls } = mount();
    fireEvent.click(button(/^uninstall$/i));
    expect(calls).toEqual([{ name: "uninstall", args: [] }]);
  });

  it("quotes the manager's detail verbatim, and only when it said something", () => {
    mount({ probe: makeProbe({ step: "offline", service: service({ detail: "launchd: spawn scheduled" }) }) });
    expect(screen.getByText("launchd: spawn scheduled")).toBeTruthy();
    cleanup();
    mount();
    expect(screen.queryByText(/^launchd:/)).toBeNull();
  });

  /** The reveals are GONE (operator ruling 2026-09-22): Status's facts carry the paths. */
  it("offers no reveals", () => {
    mount();
    expect(buttonOrNull(/reveal configuration/i)).toBeNull();
    expect(buttonOrNull(/open the node log/i)).toBeNull();
    cleanup();
    mount({ probe: makeProbe({ step: "stopped", service: service({ state: "stopped", pid: null }) }) });
    expect(buttonOrNull(/reveal configuration/i)).toBeNull();
    expect(buttonOrNull(/open the node log/i)).toBeNull();
  });
});

/** The run-at-login switch, the day-2 form of what the start-up screen asks once. */
describe("the run-at-login switch", () => {
  it("points at autostart and writes through the autostart command", () => {
    const { calls } = mount();
    const sw = switchOrNull();
    if (sw === null) throw new Error("the switch is missing from an installed service");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(calls).toEqual([{ name: "autostart", args: [false] }]);
  });

  it("falls back to `enabled` for an agent too old to answer autostart", async () => {
    const old = makeProbe({
      service: { installed: true, state: "running", enabled: true, paneSafety: "keeps", detail: "" },
    });
    const { calls } = mount({ probe: old });
    const sw = switchOrNull();
    if (sw === null) throw new Error("the fallback left no switch to press");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(calls).toEqual([{ name: "autostart", args: [false] }]);
  });

  it("refuses to guess when neither field answered, and says so", () => {
    mount({ probe: makeProbe({ service: service({ autostart: undefined, enabled: undefined }) }) });
    // The Root is Base UI's span, so "disabled" is its `data-disabled` state
    // attribute (the same spelling the stylesheet's `data-disabled:` reads),
    // not a DOM property.
    const sw = switchOrNull();
    expect(sw?.getAttribute("aria-checked")).toBe("false");
    expect(sw?.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByText(/did not report whether login start is armed/i)).toBeTruthy();
  });

  it("disables while an action is in flight", () => {
    mount({ busy: true });
    expect(switchOrNull()?.hasAttribute("data-disabled")).toBe(true);
  });

  // The version gate (round two): an agent older than the VERB still reports
  // the state — `enabled` has been answered forever — and would answer a
  // press with a usage error. So the read shows, the write is greyed, and the
  // hint names the update that unlocks it.
  it("greys the write and names the version on an agent older than the verb", () => {
    const base = makeProbe();
    mount({
      probe: { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version: "0.14.3" } : null },
    });
    expect(switchOrNull()?.getAttribute("aria-checked")).toBe("true"); // the read survives the gate
    expect(switchOrNull()?.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByText("Update your node to 0.15.0 to control this.")).toBeTruthy();
    expect(screen.queryByText(/Otherwise it stays stopped/i)).toBeNull();
  });

  it("compares numbers, so an agent at 0.9.0 is older than 0.15.0", () => {
    // A string compare answers the other way — "9" sorts above "1" — and the
    // gate would then refuse the verb on exactly the old agents it is for.
    const base = makeProbe();
    mount({ probe: { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version: "0.9.0" } : null } });
    expect(switchOrNull()?.hasAttribute("data-disabled")).toBe(true);
  });

  it("assumes an unknown version capable, as the server's twin argues", () => {
    const base = makeProbe();
    mount({ probe: { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version: null } : null } });
    expect(switchOrNull()?.hasAttribute("data-disabled")).toBe(false);
  });

  it("shows nothing where there is no service to arm", () => {
    mount({ probe: makeProbe({ step: "no-service", service: { installed: false } }) });
    expect(switchOrNull()).toBeNull();
  });
});

/** The remedy the restart refusal names BY LABEL, so the label is pinned. */
describe("the pane-safety rewrite", () => {
  it("offers the definition rewrite when a teardown would kill live panes", () => {
    const { calls } = mount({
      probe: makeProbe({ service: service({ paneSafety: "kills" }) }),
    });
    fireEvent.click(button(/rewrite the service definition/i));
    expect(calls).toEqual([{ name: "rewrite", args: [] }]);
  });
});

/** The machine-state cards the section inherited from the status screen's split. */
describe("the machine-state cards", () => {
  // Register this machine lives HERE now (operator ruling 2026-09-22,
  // screenshot 60): the act left the status screen, which keeps machine state
  // only, and joined the install offer on the node's machinery home.
  it("offers Register to a machine that is not a node, and starts the walk", () => {
    const { pressed } = mount({
      probe: makeProbe({ step: "not-enrolled", status: null, service: { installed: false } }),
    });
    // The supplement (operator ruling 2026-09-22): the card carries the
    // operator's exact-words title in the one card-title style, and the long
    // blurb is DELETED — the button speaks for itself.
    const title = screen.getByText("Enroll this machine as a node");
    expect(title.className).toContain("font-strong");
    expect(title.className).toContain("text-detail");
    expect(screen.queryByText(/Registering installs the node/)).toBeNull();
    expect(button(/^register this machine$/i)).toBeTruthy();
    fireEvent.click(button(/^register this machine$/i));
    expect(pressed).toEqual(["register"]);
  });

  it("offers no Register to a machine that is one, or one this build cannot read", () => {
    mount();
    expect(buttonOrNull(/^register this machine$/i)).toBeNull();
    cleanup();
    // The no-node mute case: installing comes first (the gate excludes it).
    mount({ probe: makeProbe({ step: "no-node", status: null, service: null }) });
    expect(buttonOrNull(/^register this machine$/i)).toBeNull();
  });

  // The facts list is Status's ALONE (operator ruling 2026-09-22, screenshot
  // 60); this section's actions' words render as the output block.
  it("renders the output block and none of the facts list", () => {
    mount();
    expect(screen.queryByText("node binary")).toBeNull();
    expect(screen.queryByText("/usr/bin/tmux")).toBeNull();
  });

  it("titles the install card 'Register as a node', with the button below it", () => {
    // Operator ruling 2026-09-22, addendum 3: the card's title is the
    // operator's exact words, and the explainer is gone (the button speaks
    // for itself).
    mount({ probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null }) });
    expect(screen.getByText("Register as a node")).toBeTruthy();
    expect(button(/install the subshell node cli/i)).toBeTruthy();
  });

  it("keeps the title on the no-bundled case, where only the sentence shows", () => {
    mount({
      probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null, bundledVersion: null }),
    });
    expect(screen.getByText("Register as a node")).toBeTruthy();
    expect(buttonOrNull(/install the subshell node cli/i)).toBeNull();
    expect(screen.getByText(/ships no node CLI/)).toBeTruthy();
  });
});

/** makeSettings is imported for the mount parity with the other screen tests. */
void makeSettings;
