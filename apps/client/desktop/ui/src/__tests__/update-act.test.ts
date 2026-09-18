/**
 * The one update act, decided (spec 2026-09-18 §§ 4, 6, 7.1).
 *
 * Pure, so every case below is a fixture rather than a machine: the four
 * shapes § 4.1 names (app behind, agent behind, both, neither), each refusal
 * § 6 lists, and the restart § 7.1 offers once the agent file has been
 * replaced.
 */
import { describe, expect, it } from "bun:test";
import type { AppUpdateCheck, Probe } from "@/lib/ipc";
import { type UpdateActInput, type UpdateActRow, updateAct } from "@/lib/update-act";
import { makeProbe } from "./harness";

/** An answered check that found nothing newer. */
function check(overrides: Partial<AppUpdateCheck> = {}): AppUpdateCheck {
  return { current: "0.8.0", latest: null, notes: null, reason: null, ...overrides };
}

function act(overrides: Partial<UpdateActInput> = {}) {
  return updateAct({
    check: check(),
    probe: makeProbe(),
    checking: false,
    installingApp: false,
    installingAgent: false,
    installedAgentHere: false,
    restartedHere: false,
    busy: false,
    // Nothing ticked by hand: every actionable row is selected by default
    // (§ 13.1), which is the old always-both behaviour.
    selection: {},
    ...overrides,
  });
}

/** One row, with the three selection fields spelled out. */
function row(over: Partial<UpdateActRow> & Pick<UpdateActRow, "id" | "label" | "from" | "to">): UpdateActRow {
  return { selected: false, selectable: false, reason: null, ...over };
}

/** A machine whose installed agent is older than the one inside this app. */
function agentBehind(overrides: Partial<Probe> = {}): Probe {
  return makeProbe({
    agentChoice: "upgrade-available",
    bundledVersion: "1.10.0",
    agent: { argv: ["/home/u/.local/bin/subshell"], source: "local-bin", version: "1.9.0" },
    ...overrides,
  });
}

describe("what the screen states (§ 4.1)", () => {
  it("names both halves when the app is behind, and cannot number the agent yet", () => {
    const a = act({ check: check({ latest: "0.8.1" }), probe: agentBehind() });
    expect(a.rows).toEqual([
      row({
        id: "app",
        label: "Subshell Client app",
        from: "0.8.0",
        to: { kind: "version", version: "0.8.1" },
        selected: true,
        selectable: true,
      }),
      // The number this app cannot know before it downloads: a desktop release
      // manifest carries the component version and its asset digests, never
      // the version of the CLI inside the bundle (§ 4.3). And no checkbox:
      // the agent half is the app act's TAIL across the relaunch, which is
      // what its cell says instead (§ 13.1).
      row({
        id: "agent",
        label: "subshell CLI",
        from: "1.9.0",
        to: { kind: "with-app" },
        selected: true,
        reason: "installs with the app",
      }),
    ]);
    expect(a.pressInstallsAgent).toBe(true);
    expect(a.press).toBe("app");
    expect(a.pressLabel).toBe("Download and Install 0.8.1");
  });

  it("states the agent alone when only it is behind, with the number in hand", () => {
    const a = act({ probe: agentBehind() });
    expect(a.rows).toEqual([
      row({
        id: "agent",
        label: "subshell CLI",
        from: "1.9.0",
        to: { kind: "version", version: "1.10.0" },
        selected: true,
        selectable: true,
      }),
    ]);
    expect(a.press).toBe("agent");
    expect(a.pressLabel).toBe("Install the agent (1.10.0)");
    expect(a.phase).toBe("idle");
  });

  /**
   * The app is current and its bundled agent is newer than what is installed:
   * a machine set up before the last app update, or one whose agent install
   * failed. One phase, and no relaunch.
   */
  it("offers the agent half on an app that is already current", () => {
    const a = act({ probe: agentBehind() });
    expect(a.rows.some((r) => r.id === "app")).toBe(false);
    expect(a.upToDate).toBe(false);
  });

  it("says nothing is behind when nothing is", () => {
    const a = act();
    expect(a.rows).toEqual([]);
    expect(a.press).toBeNull();
    expect(a.pressLabel).toBeNull();
    expect(a.upToDate).toBe(true);
  });

  /** A machine with no agent at all is a first install, not an upgrade. */
  it("names an uninstalled agent by what it is rather than by a version", () => {
    const a = act({
      probe: makeProbe({ agentChoice: "install-bundled", agent: null, managed: false, bundledVersion: "1.10.0" }),
    });
    expect(a.rows).toEqual([
      row({
        id: "agent",
        label: "subshell CLI",
        from: "not installed",
        to: { kind: "version", version: "1.10.0" },
        selected: true,
        selectable: true,
      }),
    ]);
  });

  it("is still checking until a release answer has landed", () => {
    expect(act({ check: undefined, checking: true }).phase).toBe("checking");
    // And never claims up-to-date over a question that has not been answered.
    expect(act({ check: undefined, checking: true }).upToDate).toBe(false);
  });
});

describe("the refusals (§ 6)", () => {
  /**
   * Writing a binary the service does not invoke is an update that reports
   * success and changes nothing (root AGENTS.md, "never write the installed
   * binary by convention"), so the app half runs and the agent half does not.
   */
  it("refuses the agent half on a machine running somebody else's binary, and names it", () => {
    const a = act({
      check: check({ latest: "0.8.1" }),
      probe: makeProbe({
        managed: false,
        agentChoice: "upgrade-available",
        agent: { argv: ["/opt/subshell/bin/subshell"], source: "service", version: "1.9.0" },
      }),
    });
    expect(a.rows.map((r) => r.id)).toEqual(["app", "agent"]);
    // The agent row states the refusal where its checkbox would be, and is
    // never a disabled one (§ 13.1).
    expect(a.rows[1]).toEqual(
      row({ id: "agent", label: "subshell CLI", from: "1.9.0", to: { kind: "none" }, reason: "runs another binary" }),
    );
    expect(a.refusals.join(" ")).toContain("/opt/subshell/bin/subshell");
    // The app half still runs — the refusal is half an act, not the whole one.
    expect(a.press).toBe("app");
  });

  it("keeps the agent half on an air-gapped install, and says why there is no app half", () => {
    const a = act({
      check: check({ reason: "no release source is configured (SUBSHELL_RELEASE_URL is empty)" }),
      probe: agentBehind(),
    });
    expect(a.refusals.join(" ")).toContain("SUBSHELL_RELEASE_URL is empty");
    expect(a.press).toBe("agent");
    expect(a.upToDate).toBe(false);
  });

  it("names both refusals rather than hiding one behind the other", () => {
    const a = act({
      check: check({ reason: "the release source answered 503" }),
      probe: makeProbe({
        managed: false,
        agentChoice: "upgrade-available",
        agent: { argv: ["/opt/subshell/bin/subshell"], source: "service", version: "1.9.0" },
      }),
    });
    expect(a.refusals.length).toBe(2);
  });

  it("does not offer a press while another action holds the runner", () => {
    expect(act({ probe: agentBehind(), busy: true }).canPress).toBe(false);
    expect(act({ probe: agentBehind(), installingApp: true }).canPress).toBe(false);
  });
});

describe("the second phase (§§ 4.2, 5)", () => {
  const resuming = (halted: boolean) =>
    agentBehind({ pendingInstall: { fromAppVersion: "0.8.0", attempts: halted ? 2 : 0, halted } });

  it("is finishing while a marker is outstanding, and offers no button over it", () => {
    const a = act({ probe: resuming(false) });
    expect(a.phase).toBe("finishing");
    expect(a.autoFinish).toBe(true);
    // A disabled control lettered with the thing already happening beside it
    // says less than no control at all.
    expect(a.pressLabel).toBeNull();
    expect(a.canPress).toBe(false);
  });

  /**
   * A marker on a machine whose agent this app must not replace.
   *
   * Rust resolves that to `Resume::Clear` now (`comparable_agent_version` is
   * what `decide()` always compared), so the only way here is a marker an
   * OLDER build left on disk. This layer is nonetheless the only one that can
   * SAY anything, and the worst possible reading is the one it used to
   * produce: the § 6 refusal on screen while the act fires the install it
   * names in the same breath.
   */
  it("neither fires nor presses a marker on a machine running somebody else's agent", () => {
    const a = act({
      probe: makeProbe({
        managed: false,
        agentChoice: "upgrade-available",
        bundledVersion: "1.10.0",
        agent: { argv: ["/opt/subshell/bin/subshell"], source: "service", version: "1.9.0" },
        pendingInstall: { fromAppVersion: "0.8.0", attempts: 0, halted: false },
      }),
    });
    expect(a.resume).toBeNull();
    expect(a.autoFinish).toBe(false);
    expect(a.phase).not.toBe("finishing");
    expect(a.press).toBeNull();
    expect(a.canPress).toBe(false);
    // And it says why, in the same sentence the idle offer renders.
    expect(a.refusals.join(" ")).toContain("/opt/subshell/bin/subshell");
    // Never "up to date": nothing was installed, and something is behind.
    expect(a.upToDate).toBe(false);
  });

  /**
   * At the attempt limit the boot stops firing on the person's behalf, so the
   * screen has to offer the press rather than wait for one that will not come.
   */
  it("offers Retry once it has stopped trying by itself", () => {
    const a = act({ probe: resuming(true) });
    expect(a.pressLabel).toBe("Retry");
    expect(a.press).toBe("agent");
    expect(a.canPress).toBe(true);
    // Offered, never fired: this is the one place the design refuses to keep
    // trying on someone's behalf.
    expect(a.autoFinish).toBe(false);
    // Still consented, though — the press goes through the install that asks
    // nothing, because phase 1's press covered both halves.
    expect(a.resume).not.toBeNull();
  });

  it("is downloading while the app bundle is coming down", () => {
    expect(act({ check: check({ latest: "0.8.1" }), installingApp: true }).phase).toBe("downloading");
  });
});

describe("the restart the act offers rather than performs (§ 7.1)", () => {
  /**
   * `node_install_agent` passes `--no-restart` and that stays — restarting a
   * node agent kills every subshell on a machine whose definition does not
   * spare panes. What changed is that the app now SAYS so: `rename(2)` leaves
   * the running process on its original inode, so the file is new and the
   * daemon is old, and before this nothing on screen mentioned it.
   */
  it("offers a restart once this window replaced the agent", () => {
    const a = act({ installedAgentHere: true });
    expect(a.offerRestart).toBe(true);
    expect(a.phase).toBe("done");
    // The offer IS what the screen says here, so there is nothing to settle.
    expect(a.settled).toBe(false);
  });

  it("stops offering it once the restart has happened", () => {
    expect(act({ installedAgentHere: true, restartedHere: true }).offerRestart).toBe(false);
  });

  it("offers nothing to restart on a machine with no service", () => {
    const a = act({ installedAgentHere: true, probe: makeProbe({ service: { installed: false } }) });
    expect(a.offerRestart).toBe(false);
  });

  /**
   * The two states where the screen used to go BLANK: the act is done, so
   * there are no rows and no offer, and `upToDate` is false precisely BECAUSE
   * this window installed something. A screen that says nothing at the end of
   * a successful act reads as one that lost the thread.
   */
  it("says the act is finished once there is nothing left to offer", () => {
    expect(act({ installedAgentHere: true, restartedHere: true }).settled).toBe(true);
    expect(act({ installedAgentHere: true, probe: makeProbe({ service: { installed: false } }) }).settled).toBe(true);
    // Not while a half is still named on screen — an app update that landed
    // after the agent one must not be covered by "both up to date".
    expect(act({ installedAgentHere: true, restartedHere: true, check: check({ latest: "0.9.0" }) }).settled).toBe(
      false,
    );
  });

  it("warns about panes only where the definition does not spare them", () => {
    expect(act({ installedAgentHere: true }).restartCostsPanes).toBe(false);
    const risky = act({
      installedAgentHere: true,
      probe: makeProbe({ service: { installed: true, state: "running", paneSafety: "kills" } }),
    });
    expect(risky.restartCostsPanes).toBe(true);
  });

  /** `unknown` fails closed everywhere else here, and must here too. */
  it("fails closed on a definition it could not read", () => {
    const a = act({
      installedAgentHere: true,
      probe: makeProbe({ service: { installed: true, state: "running", paneSafety: "unknown" } }),
    });
    expect(a.restartCostsPanes).toBe(true);
  });
});

/**
 * Reported by the operator on 2026-09-18, against Subshell Server and true of
 * this app for the same structural reason: a CLI updated by hand outranks the
 * one inside the bundle (`decide_agent` adopts it and never downgrades), and
 * the screen went on naming it as a target it would be replaced by.
 */
describe("the act is a selection, not always both halves (§ 13)", () => {
  /** A machine running an agent NEWER than the one this app ships. */
  const agentNewer = (overrides: Partial<Probe> = {}): Probe =>
    makeProbe({
      agentChoice: "adopt-installed",
      bundledVersion: "1.9.0",
      agent: { argv: ["/home/u/.local/bin/subshell"], source: "local-bin", version: "1.11.0" },
      ...overrides,
    });

  it("never names an older bundled agent as the target of a newer installed one", () => {
    const a = act({ check: check({ latest: "0.8.1" }), probe: agentNewer() });
    expect(a.rows[1]).toEqual(
      row({ id: "agent", label: "subshell CLI", from: "1.11.0", to: { kind: "none" }, reason: "you run a newer one" }),
    );
    // And the sentence beside the press stops promising the half that will
    // not run: phase 2 answers `Resume::Clear` on this machine.
    expect(a.pressInstallsAgent).toBe(false);
    // The app half is untouched by any of it.
    expect(a.press).toBe("app");
    expect(a.canPress).toBe(true);
  });

  it("refuses a marker on that machine rather than firing a downgrade (§ 13.2)", () => {
    const a = act({ probe: agentNewer({ pendingInstall: { fromAppVersion: "0.8.0", attempts: 0, halted: false } }) });
    expect(a.resume).toBeNull();
    expect(a.autoFinish).toBe(false);
    expect(a.phase).not.toBe("finishing");
  });

  it("hands the agent half its own checkbox once the app half is unticked", () => {
    const behind = agentBehind();
    const both = act({ check: check({ latest: "0.8.1" }), probe: behind });
    expect(both.rows.map((r) => r.selectable)).toEqual([true, false]);

    const appOff = act({ check: check({ latest: "0.8.1" }), probe: behind, selection: { app: false } });
    // With nothing crossing a relaunch, the agent half is an act of its own —
    // and its number is in hand, because it is THIS bundle's agent.
    expect(appOff.rows[1]).toEqual(
      row({
        id: "agent",
        label: "subshell CLI",
        from: "1.9.0",
        to: { kind: "version", version: "1.10.0" },
        selected: true,
        selectable: true,
      }),
    );
    expect(appOff.press).toBe("agent");
    expect(appOff.pressLabel).toBe("Install the agent (1.10.0)");
    expect(appOff.pressInstallsAgent).toBe(false);
  });

  it("is dead, and says why, when everything is unticked", () => {
    const a = act({
      check: check({ latest: "0.8.1" }),
      probe: agentBehind(),
      selection: { app: false, agent: false },
    });
    expect(a.press).toBeNull();
    expect(a.canPress).toBe(false);
    // Dead rather than absent: a button that vanished would leave the table
    // with no way back to the act it describes.
    expect(a.pressLabel).toBe("Nothing selected");
  });

  it("offers no press at all when there was never anything to select", () => {
    expect(act().pressLabel).toBeNull();
  });

  it("states an unreachable release source in the app row's own cell", () => {
    const a = act({ check: check({ reason: "the release source answered 503" }), probe: agentBehind() });
    expect(a.rows[0]).toEqual(
      row({
        id: "app",
        label: "Subshell Client app",
        from: "0.8.0",
        to: { kind: "none" },
        reason: "cannot be checked",
      }),
    );
  });

  /**
   * The air-gapped sentence promises the local half, so it may only promise it
   * where that half has something to do — the same rule § 13 applies to the
   * press's own sentence.
   */
  it("stops promising a local install where there is none to make", () => {
    const a = act({ check: check({ reason: "the release source answered 503" }), probe: agentNewer() });
    expect(a.refusals).toEqual(["the release source answered 503"]);
    expect(a.press).toBeNull();
  });

  /**
   * **A table never omits a component it knows about** (review, 2026-09-18).
   *
   * An air-gapped check beside a current agent used to render the app row
   * alone — "cannot be checked" against one component and silence about the
   * other — which is the guess § 13.1 exists to remove, and is the case where
   * this app and Subshell Server implemented one stated rule two ways.
   */
  it("states the agent beside an app row it cannot answer for", () => {
    const a = act({ check: check({ reason: "the release source answered 503" }) });
    expect(a.rows.map((r) => r.id)).toEqual(["app", "agent"]);
    expect(a.rows[1].reason).toBe("up to date");
  });

  /** And where nothing at all is in question there is no table to be in. */
  it("still shows no rows when neither half has anything to say", () => {
    const a = act();
    expect(a.rows).toEqual([]);
    expect(a.upToDate).toBe(true);
  });

  /**
   * A build that will not name the agent it ships cannot be called up to date
   * or behind — so the row says that, rather than being dropped from a table
   * the app row is already in.
   */
  it("names a build that does not report what it ships", () => {
    const a = act({
      check: check({ reason: "the release source answered 503" }),
      probe: makeProbe({ bundledVersion: null }),
    });
    expect(a.rows.map((r) => r.id)).toEqual(["app", "agent"]);
    expect(a.rows[1].reason).toBe("this build does not say which agent it ships");
    expect(a.rows[1].selectable).toBe(false);
  });

  it("leaves no checkbox anywhere while an act is running", () => {
    const a = act({ check: check({ latest: "0.8.1" }), probe: agentBehind(), installingApp: true });
    expect(a.rows.every((r) => !r.selectable)).toBe(true);
    // And the app row says nothing where its checkbox was: the decision is
    // made, and the progress line is what the screen has to say.
    expect(a.rows[0].reason).toBeNull();
  });
});
