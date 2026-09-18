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
import { type UpdateActInput, updateAct } from "@/lib/update-act";
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
    ...overrides,
  });
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
      { id: "app", label: "Subshell Client app", from: "0.8.0", to: "0.8.1" },
      // The number this app cannot know before it downloads: a desktop release
      // manifest carries the component version and its asset digests, never
      // the version of the CLI inside the bundle (§ 4.3).
      { id: "agent", label: "subshell CLI", from: "1.9.0", to: null },
    ]);
    expect(a.press).toBe("app");
    expect(a.pressLabel).toBe("Download and Install 0.8.1");
  });

  it("states the agent alone when only it is behind, with the number in hand", () => {
    const a = act({ probe: agentBehind() });
    expect(a.rows).toEqual([{ id: "agent", label: "subshell CLI", from: "1.9.0", to: "1.10.0" }]);
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
    expect(a.rows).toEqual([{ id: "agent", label: "subshell CLI", from: "not installed", to: "1.10.0" }]);
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
    expect(a.rows.map((r) => r.id)).toEqual(["app"]);
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
