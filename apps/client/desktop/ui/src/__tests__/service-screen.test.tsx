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
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ServiceScreen } from "@/components/assistant/service-screen";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, ServiceStatusBody } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);
// The hush grace is read off `Date.now()`; any test that mocks the clock
// restores it here rather than trusting its own last line to run.
afterEach(() => setSystemTime());

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
    unenroll: rec("unenroll"),
    openPath: rec("openPath"),
    openPlane: rec("openPlane"),
    openPlaneUrl: rec("openPlaneUrl"),
    installTmux: rec("installTmux"),
    addPlane: rec("addPlane"),
    removePlane: rec("removePlane"),
    register: rec("register"),
  };
}

const shell = { title: "Service", subtitle: "The node is the small program.", problem: "" };

function mount(
  init: {
    probe?: ReturnType<typeof makeProbe>;
    busy?: boolean;
    active?: string | null;
    output?: ActionResult | null;
  } = {},
) {
  const calls: Call[] = [];
  const pressed: string[] = [];
  renderApp(
    <ServiceScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      commands={makeCommands(calls)}
      busy={init.busy ?? false}
      active={init.active ?? null}
      onRegister={() => pressed.push("register")}
      output={init.output ?? null}
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

  it("offers Start inside the arrangement card, and does NOT re-say the badge", () => {
    // Ruling 2026-09-22: "just remove this, the badge already shows the
    // status" — the chip reads "Service stopped"; the sentence must not
    // return beside it.
    const { calls } = mount({ probe: stopped });
    expect(screen.queryByText(/the node is not running/i)).toBeNull();
    expect(screen.getByText("Service stopped")).toBeTruthy();
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
    // The card's exact current-condition sentence and the exact help the
    // armed switch owes (copy wave review, item 5: the pattern's variants
    // must be pinned, not sampled).
    expect(
      screen.getByText(
        "Currently the Subshell Node Service runs in the background, and starts automatically on startup.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Turning this off leaves it running in the background, but it will not start again after a startup.",
      ),
    ).toBeTruthy();
    fireEvent.click(sw);
    expect(calls).toEqual([{ name: "autostart", args: [false] }]);
  });

  it("states the disarmed condition, and what the press arms", () => {
    mount({ probe: makeProbe({ service: service({ autostart: false }) }) });
    expect(
      screen.getByText(
        "Currently the Subshell Node Service runs in the background, but does not automatically start on startup.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Turning this on starts it automatically every time the machine starts.")).toBeTruthy();
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
    expect(
      screen.getByText(
        "Currently the Subshell Node Service runs in the background. Whether it starts on startup is not reported.",
      ),
    ).toBeTruthy();
    // Unknown speaks through the card alone: the switch's help line is EMPTY
    // rather than a guess about what flipping would change.
    expect(screen.queryByText(/Turning this/i)).toBeNull();
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
    expect(
      screen.getByText("Currently the installed version cannot change this. Updating to version 0.15.0 lets you."),
    ).toBeTruthy();
    expect(screen.queryByText(/Turning this/i)).toBeNull();
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

/** The un-enroll card (plane-list wave): gated on the verb, on the node only. */
describe("Un-enroll", () => {
  it("is offered on an enrolled machine and runs the confirmed command", () => {
    const { calls } = mount();
    fireEvent.click(button("Un-enroll…"));
    expect(calls).toEqual([{ name: "unenroll", args: [] }]);
  });

  it("is NOT offered on a machine that is not a node", () => {
    mount({ probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }) });
    expect(buttonOrNull(/un-enroll/i)).toBeNull();
  });

  it("shows the gate sentence on an agent too old for the verb", () => {
    const base = makeProbe();
    mount({
      probe: { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version: "0.14.0" } : null },
    });
    expect(button("Un-enroll…").disabled).toBe(true);
    expect(screen.getByText(/needs node version 0\.15\.0 or newer\. Update the node first\./i)).toBeTruthy();
  });

  // The card's final shape (ruling 2026-09-22: "can we move unenroll next
  // to re-enroll and remove that divider"): one row for both binding acts,
  // the gate sentence under it, and no rule splitting the card in two.
  it("a success leaves no receipt here; a refusal still answers verbatim", () => {
    // Ruling 2026-09-22, on the "subshell restarted." line: "just remove
    // it, the user won't notice it anyways". The card already moved; the
    // spinner and the chip said their piece.
    mount({ output: { ok: true, stdout: "subshell restarted.", stderr: "" } });
    expect(screen.queryByText(/subshell restarted/)).toBeNull();
    cleanup();
    mount({ output: { ok: false, stdout: "", stderr: "Failed to restart: Unit is masked." } });
    expect(screen.getByText(/Unit is masked/)).toBeTruthy();
  });

  it("stands the two binding acts on one row with no divider", () => {
    mount();
    const re = button("Re-enroll…");
    const un = button("Un-enroll…");
    expect(re.parentElement).toBe(un.parentElement);
    expect(re.parentElement?.className).toContain("flex");
    // No rule inside the card (the frame's own bar may keep its border;
    // this asserts the card, not the page).
    const card = re.closest('[class*="rounded-md"]');
    expect(card).not.toBeNull();
    expect(card?.querySelectorAll('[class*="border-t"]').length).toBe(0);
  });
});

/**
 * The press narrates the card (operator rulings 2026-09-22, from the live
 * window: "when clicking restart, there should be a spinner saying
 * restarting. same with the stop / start button", and "when restarting this
 * additional message occurs, can we remove it"). The runner carries the
 * pressed act as `active`; the button wearing it turns into a spinner and
 * the progressive word, and the card's problem sentences hold their breath
 * until the act has settled.
 */
describe("while the section's own act is in flight", () => {
  it("the pressed button shows a spinner and the progressive word", () => {
    mount({ busy: true, active: "restart" });
    expect(button(/Restarting…/)).toBeTruthy();
    expect(buttonOrNull(/^Restart$/)).toBeNull();
    expect(button("Stop").textContent).toBe("Stop");
  });

  // "why does it say online while it's restarting" — the header chip used to
  // repeat the last read, which is stale for seconds on purpose (the probe's
  // online verdict is heartbeat freshness, and it survives the signal).
  // While a starting act runs, the chip tells the act's story instead.
  it("the header chip says Restarting, not the pre-kick Online", () => {
    mount({ busy: true, active: "restart" });
    // Two wear the word now — the chip and the button — so the chip is
    // picked by its own dress (the muted chip class), not by uniqueness.
    const chips = screen.getAllByText("Restarting…");
    expect(chips.some((el) => el.className.includes("bg-muted"))).toBe(true);
    expect(screen.queryByText("Online")).toBeNull();
    cleanup();
    // And the act's end hands the chip back to the machine's own verdict.
    mount({ probe: makeProbe() });
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("the starting verb wears Starting…", () => {
    mount({
      busy: true,
      active: "start",
      probe: makeProbe({ step: "stopped", service: service({ state: "stopped" }) }),
    });
    expect(button(/Starting…/)).toBeTruthy();
    // Only the button whose act runs changes; its neighbours keep their words.
    expect(button("Uninstall").textContent).toBe("Uninstall");
  });

  it("the confirmed chains spin from the dialog's Accept to the answer", () => {
    // The label rides the runner through `accept()` (see `active` in
    // `use-action-runner`): between Accept and the settled re-probe the
    // button the person pressed is the one that says what it is doing.
    mount({ busy: true, active: "uninstall" });
    expect(button(/Uninstalling…/)).toBeTruthy();
    cleanup();
    mount({ busy: true, active: "unenroll" });
    expect(button(/Un-enrolling…/)).toBeTruthy();
  });

  it("the offline sentences wait out the act, and say their piece after", () => {
    const offline = makeProbe({ step: "offline" });
    mount({ probe: offline, busy: true, active: "restart" });
    expect(screen.queryByText(/service manager reports the node as running/i)).toBeNull();
    expect(screen.queryByText(/A node that starts, fails/i)).toBeNull();
    // The arrangement it always states is NOT part of the hush.
    expect(screen.getByText(/runs in the background/i)).toBeTruthy();
    cleanup();
    mount({ probe: offline });
    expect(screen.getByText(/service manager reports the node as running/i)).toBeTruthy();
  });

  // The follow-up ruling, from the same live window: busy is not the whole
  // of coming back. The manager needs a few probe cycles after a deliberate
  // kick, so after a STARTING act the hush outlives the spinner by the
  // named grace, and what then surfaces is written as the warning it is.
  it("the hush outlives the spinner after a starting act, then the warning says its piece", () => {
    const offline = makeProbe({ step: "offline" });
    setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const ended = { label: "restart", at: Date.now() };
    const { again } = mountView({ probe: offline, busy: true, active: "restart" });
    expect(screen.queryByText(/service manager reports the node as running/i)).toBeNull();
    // The act settles. The spinner is gone; the daemon is still booting.
    again({ probe: offline, busy: false, active: null, actEnded: ended });
    expect(screen.queryByText(/service manager reports the node as running/i)).toBeNull();
    // The grace ends on a later poll, and the sentence arrives in the
    // screen's warning dress ("it should probably be written as a yellow
    // warning"), not as body text.
    setSystemTime(new Date("2026-09-22T12:00:16Z"));
    again({ probe: offline, busy: false, active: null, actEnded: ended });
    const line = screen.getByText(/service manager reports the node as running/i);
    expect(line.closest("[class*='warning']")).not.toBeNull();
    expect(screen.getByText(/A node that starts, fails/i)).toBeTruthy();
  });

  it("a stop keeps no grace: its answer is on the card the moment the act ends", () => {
    // The grace belongs to STARTING acts. Stop's answer is the absence, and
    // it is true the instant the verb returns — (a stopped machine's own
    // sentence was deleted by the badge ruling; OFFLINE is the live case:
    // manager still saying running, nothing heartbeating, seconds after a
    // stop, and it must not wait anything out).
    const offline = makeProbe({ step: "offline" });
    setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const { again } = mountView({ probe: offline, busy: true, active: "stop" });
    expect(screen.queryByText(/service manager reports the node as running/i)).toBeNull();
    again({ probe: offline, busy: false, active: null, actEnded: { label: "stop", at: Date.now() } });
    expect(screen.getByText(/service manager reports the node as running/i)).toBeTruthy();
  });
});

/** Like `mount`, but hands back an `again(...)` that rerenders the SAME
 *  screen with new props — the hush grace compares `Date.now()` to the
 *  runner's stamp, so it moves between renders, not inside them. */
interface ViewInit {
  probe: ReturnType<typeof makeProbe>;
  busy?: boolean;
  active?: string | null;
  actEnded?: { label: string | null; at: number } | null;
}

function mountView(init: ViewInit) {
  const calls: Call[] = [];
  const tree = (v: ViewInit) => (
    <ServiceScreen
      shell={shell}
      probe={v.probe}
      commands={makeCommands(calls)}
      busy={v.busy ?? false}
      active={v.active ?? null}
      actEnded={v.actEnded ?? null}
      onRegister={() => {}}
      output={null as ActionResult | null}
    />
  );
  const view = renderApp(tree(init));
  return { calls, again: (over: ViewInit) => view.rerender(tree(over)) };
}
