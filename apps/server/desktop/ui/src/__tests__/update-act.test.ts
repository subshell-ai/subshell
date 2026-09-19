/**
 * The one update act's whole decision (spec 2026-09-18 § 4, § 6, § 13).
 *
 * This file is where the screen is actually covered. `ui/src/__tests__/` has
 * no DOM harness — nothing here can mount `wizard.ts` — so a judgment left in
 * the render is a judgment with no test at all, and the point of
 * `lib/update-act.ts` is that every one of them is here instead.
 *
 * What it pins, in the order the spec states it: the four cases of § 4.1 (app
 * behind, server behind, both, neither), the two phases of § 4.2 across the
 * relaunch, each refusal of § 6 — a server this app did not install, an
 * air-gapped source, and an act already in flight — and § 13's amendment, which
 * turned the act into a SELECTION after an operator was shown a screen
 * promising to install a server older than the one they were running.
 */
import { describe, expect, it } from "bun:test";
import type { AppUpdateCheck, PendingInstall, Probe } from "../lib/ipc";
import {
  leaveHeld,
  rejectedResult,
  UPDATE_TITLE,
  type UpdateActInput,
  type UpdateActSelection,
  updateAct,
} from "../lib/update-act";

/** A machine with a managed server running, current with what this app ships. */
function machine(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "0.10.0",
    server: { argv: ["/home/u/.local/bin/subshell-server"], source: "local-bin", version: "0.10.0" },
    managed: true,
    status: null,
    service: { installed: true, state: "running", paneSafety: "keeps" },
    serverChoice: "up-to-date",
    next: "ready",
    error: null,
    tmux: "/usr/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: true,
    hostname: "mac",
    pendingInstall: null,
    ...over,
  } as Probe;
}

/** The same machine with an older server installed than the one this app ships. */
const SERVER_BEHIND: Partial<Probe> = {
  serverChoice: "upgrade-available",
  server: { argv: ["/home/u/.local/bin/subshell-server"], source: "local-bin", version: "0.9.0" },
};

/**
 * The § 13 machine: a `subshell-server` updated by hand, NEWER than the one
 * this app ships. The ladder adopts it, so there is nothing for the act to do.
 */
const SERVER_AHEAD: Partial<Probe> = {
  serverChoice: "adopt-installed",
  server: { argv: ["/home/u/.local/bin/subshell-server"], source: "local-bin", version: "0.10.1" },
};

/** A definition that does NOT spare live panes. */
const KILLS_PANES: Partial<Probe> = {
  service: { installed: true, state: "running", paneSafety: "kills" },
} as Partial<Probe>;

const NO_APP_UPDATE: AppUpdateCheck = { current: "0.8.0", latest: null, notes: null, reason: null };
const APP_BEHIND: AppUpdateCheck = {
  current: "0.8.0",
  latest: "0.8.1",
  notes: "https://example.invalid/releases/tag/desktop-server-v0.8.1",
  reason: null,
};
const AIR_GAPPED: AppUpdateCheck = {
  current: "0.8.0",
  latest: null,
  notes: null,
  reason: "no release source is configured (SUBSHELL_RELEASE_URL is empty)",
};

function marker(over: Partial<PendingInstall> = {}): PendingInstall {
  return { fromAppVersion: "0.8.0", forced: false, halted: false, ...over };
}

/** Nothing ticked by hand — the screen as it is first drawn. */
const UNTOUCHED: UpdateActSelection = { rows: {}, force: null };

function act(over: Partial<UpdateActInput> = {}) {
  return updateAct({
    probe: machine(),
    appUpdate: NO_APP_UPDATE,
    state: "idle",
    finished: null,
    selection: UNTOUCHED,
    busy: false,
    ...over,
  });
}

/** The row for one half. Both are always stated on the offer (§ 13.1). */
const row = (view: ReturnType<typeof act>, id: "app" | "cli") => view.rows.find((r) => r.id === id);

describe("the four cases of §4.1", () => {
  it("states both halves when both are behind, and ticks both", () => {
    const view = act({ probe: machine(SERVER_BEHIND), appUpdate: APP_BEHIND });
    expect(view.phase).toBe("idle");
    expect(row(view, "app")).toEqual({
      id: "app",
      label: "Subshell Server app",
      from: "0.8.0",
      to: "0.8.1",
      selected: true,
      reason: null,
    });
    // `to: null` is the honest answer rather than a missing number: a desktop
    // release manifest carries the component's version and its asset digests,
    // never the version of the CLI inside the bundle (§ 4.3). The number
    // appears after the relaunch, and the screen says "the server it ships"
    // until then.
    expect(row(view, "cli")).toEqual({
      id: "cli",
      label: "subshell-server CLI",
      from: "0.9.0",
      to: null,
      selected: true,
      reason: null,
    });
    // D1 unchanged: both ticked, one press does both.
    expect(view.press).toEqual({
      label: "Download and Install 0.8.1",
      kind: "app",
      enabled: true,
      bundled: true,
      forced: false,
    });
  });

  it("still ticks the server half when only the APP is behind", () => {
    // The app ships the server, so the act installs one even from a machine
    // whose server is current: the NEW bundle's copy is newer than what is
    // here. A screen that showed the app row alone would describe half of what
    // its own button does.
    const view = act({ appUpdate: APP_BEHIND });
    expect(row(view, "app")?.to).toBe("0.8.1");
    expect(row(view, "cli")).toEqual({
      id: "cli",
      label: "subshell-server CLI",
      from: "0.10.0",
      to: null,
      selected: true,
      reason: null,
    });
  });

  it("names both numbers when only the SERVER is behind, and does not relaunch", () => {
    // The case with no phase 2: the app is current, so the bundled server it
    // already carries is installed here and now, and its target version is a
    // number this build knows.
    const view = act({ probe: machine(SERVER_BEHIND) });
    expect(row(view, "app")).toEqual({
      id: "app",
      label: "Subshell Server app",
      from: "0.8.0",
      to: null,
      selected: null,
      reason: "up to date",
    });
    expect(row(view, "cli")?.to).toBe("0.10.0");
    expect(view.press).toEqual({
      label: "Update and Restart",
      kind: "cli",
      enabled: true,
      bundled: true,
      forced: false,
    });
  });

  it("states both halves and offers nothing when neither is behind", () => {
    const view = act();
    // The rows are still there — a component the screen knows about and does
    // not state is one the reader has to guess at (§ 13.1).
    expect(view.rows.map((r) => [r.id, r.selected, r.reason])).toEqual([
      ["app", null, "up to date"],
      ["cli", null, "up to date"],
    ]);
    expect(view.press).toBeNull();
    expect(view.subtitle).toContain("both current");
  });

  it("treats a machine with no server installed as work the act can do", () => {
    // `install-bundled` is the first install, not a refusal: nothing is
    // resolved, so nothing is being overwritten and the app owns what it
    // writes. It is reachable here through the boot resume on a machine whose
    // server was removed between the press and the relaunch.
    const view = act({ probe: machine({ serverChoice: "install-bundled", server: null, managed: false }) });
    expect(row(view, "cli")).toEqual({
      id: "cli",
      label: "subshell-server CLI",
      from: "not installed",
      to: "0.10.0",
      selected: true,
      reason: null,
    });
    expect(view.press?.kind).toBe("cli");
  });
});

describe("the two phases of §4.2", () => {
  it("finishes without a press, because the press already happened", () => {
    // Phase 2 is the tail of a consent given in the PREVIOUS process. A button
    // here would be asking someone to confirm the second half of an act they
    // already chose — which is the defect the whole spec exists to remove.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }) });
    expect(view.phase).toBe("finishing");
    expect(view.press).toBeNull();
    expect(view.subtitle).toContain("updated from 0.8.0");
  });

  it("states the one component it is acting on, and offers no checkbox for it", () => {
    // No SELECTION in phase 2: the act was chosen in the previous process, so
    // the row states it rather than offering it.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }) });
    expect(view.rows).toEqual([
      { id: "cli", label: "subshell-server CLI", from: "0.9.0", to: "0.10.0", selected: null, reason: null },
    ]);
  });

  it("outranks every phase-1 question, including a release answer already in hand", () => {
    // The check's answer is about an app that has just been replaced. Letting
    // it render would offer a download over a machine mid-install.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }), appUpdate: APP_BEHIND });
    expect(view.phase).toBe("finishing");
    expect(row(view, "app")).toBeUndefined();
  });

  it("names the number § 4.3 could not state until the relaunch", () => {
    // Phase 1 shows `to: null` because only the new bundle knows which server
    // it carries. THIS process is that bundle, so the target is a number here
    // — and the halted screen, which stops and explains itself, is where a
    // person most needs to know which install is meant (review, 2026-09-18:
    // nothing persists a REASON across the relaunch, so the versions are what
    // the screen can honestly state).
    const behind = { ...SERVER_BEHIND, pendingInstall: marker() };
    expect(row(act({ probe: machine(behind) }), "cli")?.to).toBe("0.10.0");
    expect(row(act({ probe: machine({ ...behind, pendingInstall: marker({ halted: true }) }) }), "cli")?.to).toBe(
      "0.10.0",
    );
  });

  it("refuses the second half on a machine whose server this app did not install", () => {
    // Defence in depth for a marker an OLDER build left behind: Rust now
    // clears one here, because `resume_decision` is fed the managed-aware
    // version. If one survives anyway, firing would write `~/.local/bin` and
    // restart a service running someone else's binary — after a phase-1
    // screen that promised neither. This is the only layer that can SAY that,
    // since the install itself would report success.
    const view = act({
      probe: machine({
        ...SERVER_BEHIND,
        managed: false,
        server: { argv: ["/usr/bin/subshell-server"], source: "path", version: "0.9.0" },
        pendingInstall: marker(),
      }),
    });
    // NOT `finishing`: that phase fires by itself when it carries no press.
    expect(view.phase).toBe("halted");
    expect(view.press).toBeNull();
    expect(row(view, "cli")?.reason).toBe("not this app's");
    expect(view.notes.join(" ")).toContain("/usr/bin/subshell-server");
    expect(view.force).toBeNull();
  });

  it("turns a rejection into an attempt that failed, so the screen keeps a control", () => {
    // `finishUpdate`'s calls can REJECT — a refusal that fired before anything
    // ran, an IPC failure — and a null `finished` reads as "nothing has been
    // attempted here": no Try Again, with the automatic fire already latched
    // for the visit (review, 2026-09-18).
    const view = act({
      probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }),
      finished: rejectedResult("the server is already being updated"),
    });
    expect(view.press).toEqual({ label: "Try Again", kind: "cli", enabled: true, bundled: true, forced: false });
  });

  it("offers Try Again when the finishing install failed here", () => {
    const view = act({
      probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }),
      finished: { ok: false },
    });
    expect(view.phase).toBe("finishing");
    expect(view.press?.label).toBe("Try Again");
  });

  it("stops firing by itself once the attempts are spent, and says what is running", () => {
    // The one place this design refuses to keep trying on someone's behalf: a
    // failure on every boot would otherwise take the window to a failure screen
    // on every launch, forever.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker({ halted: true }) }) });
    expect(view.phase).toBe("halted");
    expect(view.press?.label).toBe("Try Again");
    expect(view.notes.join(" ")).toContain("server it had before the update");
  });

  it("reports what THIS window finished, after the marker it cleared is gone", () => {
    // A successful install clears the marker, so the probe stops reporting one
    // within 1500 ms. Without the page's own answer the screen would forget
    // what it had just done and offer the act again.
    const view = act({ finished: { ok: true } });
    expect(view.phase).toBe("done");
    expect(view.press).toBeNull();
    expect(view.rows).toEqual([]);
    expect(view.subtitle).toBe("Subshell Server and the server it ships are both up to date.");
  });

  /**
   * A closing sentence may only speak for what was installed (review,
   * 2026-09-18). § 13 made the act a selection, so a CLI-only press — the app
   * row unticked — used to end on "both up to date" over an app a release
   * behind, which is the same overclaim the table was rebuilt to remove.
   */
  it("does not call the app current after a press that only touched the server", () => {
    const view = act({ finished: { ok: true }, appUpdate: APP_BEHIND });
    expect(view.subtitle).toBe("The server on this machine is up to date. Subshell Server 0.8.1 is still available.");
  });

  /**
   * **`busy` is not `state`** (review, 2026-09-18). `state` tracks the APP
   * install's phases; the CLI half runs through the page's action runner and
   * never touches it. Without this the primary button stayed live through a
   * `subshell-server update --from` budgeted at 300 s — greyed checkboxes, a
   * live-looking button and no progress line, which reads as a hung screen.
   */
  it("goes dead while this window is already doing something", () => {
    const running = act({ probe: machine(SERVER_BEHIND), appUpdate: APP_BEHIND, busy: true });
    expect(running.press?.enabled).toBe(false);
    // The press is still NAMED: a button that vanished mid-act would take the
    // only description of what is happening with it.
    expect(running.press?.label).toBe("Download and Install 0.8.1");
  });

  it("says the app restarts while the download runs", () => {
    const view = act({ appUpdate: APP_BEHIND, state: "downloading" });
    expect(view.phase).toBe("downloading");
    expect(view.press).toBeNull();
    expect(view.subtitle).toContain("0.8.1");
    expect(view.subtitle).toContain("restarts");
  });

  it("says it is checking before the release list has answered", () => {
    expect(act({ appUpdate: null, state: "checking" }).phase).toBe("checking");
    // And before the first probe: a screen drawn against no machine must not
    // claim anything about it.
    expect(act({ probe: null, appUpdate: null }).phase).toBe("checking");
  });
});

describe("§13: the act is a selection", () => {
  it("does not offer to install a server older than the one running", () => {
    // The operator's report, 2026-09-18: app 0.8.1, a hand-updated CLI at
    // 0.10.1, and a screen naming a version older than the running one as a
    // target while promising an install `Resume::Clear` would never perform.
    const view = act({ probe: machine(SERVER_AHEAD), appUpdate: APP_BEHIND });
    expect(row(view, "cli")).toEqual({
      id: "cli",
      label: "subshell-server CLI",
      from: "0.10.1",
      to: null,
      selected: null,
      reason: "you run a newer one",
    });
    // The app half still runs — it was never the false half.
    expect(view.press?.kind).toBe("app");
    // And the marker is not written, so phase 2 does not fire on the far side.
    expect(view.press?.bundled).toBe(false);
  });

  it("stops the subtitle promising the CLI half when it will not run", () => {
    expect(act({ probe: machine(SERVER_AHEAD), appUpdate: APP_BEHIND }).subtitle).not.toContain(
      "also installs the server it ships",
    );
    // Where it WILL run, the sentence is unchanged.
    expect(act({ probe: machine(SERVER_BEHIND), appUpdate: APP_BEHIND }).subtitle).toContain(
      "also installs the server it ships",
    );
  });

  it("names the supported way to move a server backwards instead of offering one", () => {
    // § 13.2: boot's migrator is forward-only, so an older server cannot boot
    // on a database a newer one migrated. Force may not make that a checkbox.
    const view = act({ probe: machine(SERVER_AHEAD) });
    expect(view.notes.join(" ")).toContain("update --from");
    expect(view.press).toBeNull();
    expect(view.subtitle).toContain("newer server than this app ships");
  });

  it("runs only what is ticked, and is dead when nothing is", () => {
    const both = { probe: machine(SERVER_BEHIND), appUpdate: APP_BEHIND };
    // Untick the CLI: the app half still runs, and no marker is written.
    const appOnly = act({ ...both, selection: { rows: { cli: false }, force: null } });
    expect(appOnly.press).toEqual({
      label: "Download and Install 0.8.1",
      kind: "app",
      enabled: true,
      bundled: false,
      forced: false,
    });
    expect(appOnly.subtitle).toContain("not part of this update");
    // Untick the app: the CLI half runs here and now.
    const cliOnly = act({ ...both, selection: { rows: { app: false }, force: null } });
    expect(cliOnly.press?.kind).toBe("cli");
    expect(cliOnly.press?.label).toBe("Update and Restart");
    // Untick both: the button stays, so the table does not jump under the hand
    // that cleared the last box, and it is dead.
    const neither = act({ ...both, selection: { rows: { app: false, cli: false }, force: null } });
    expect(neither.press).toEqual({ label: "Update", kind: "app", enabled: false, bundled: false, forced: false });
  });

  /**
   * **Unticking the app must not leave a restart behind** (review, 2026-09-18).
   *
   * The CLI row rode the app row's TICKABILITY, so on the commonest shape of
   * all — a behind app beside a current server — clearing the app box left the
   * CLI box ticked and the press became `Update and Restart`. That press is
   * not a no-op: `subshell-server update --from` prints "Already at X." and
   * exits 0, so the install reports success and the service is restarted —
   * closing every live subshell on a machine whose definition does not spare
   * them, for an install that changed nothing.
   */
  it("leaves nothing to press when the app is unticked and the server is current", () => {
    const appBehindOnly = { probe: machine(KILLS_PANES), appUpdate: APP_BEHIND };
    const ticked = act(appBehindOnly);
    expect(ticked.press?.kind).toBe("app");
    // The CLI rides along while the app runs — that is § 4.3, unchanged.
    expect(row(ticked, "cli")?.selected).toBe(true);

    const cleared = act({ ...appBehindOnly, selection: { rows: { app: false }, force: null } });
    // Re-derived as a standalone act, which does not exist on this machine.
    expect(row(cleared, "cli")).toMatchObject({ selected: null, reason: "up to date" });
    expect(cleared.press?.enabled).toBe(false);
    // And no Force box, because nothing here restarts anything.
    expect(cleared.force).toBeNull();
    // The sentence may not promise the app install either.
    expect(cleared.subtitle).not.toContain("also installs the server it ships");
  });

  /** The same clearing on a machine where the server IS behind keeps its act. */
  it("keeps the server's own act when the app is unticked and the server is behind", () => {
    const cleared = act({
      probe: machine(SERVER_BEHIND),
      appUpdate: APP_BEHIND,
      selection: { rows: { app: false }, force: null },
    });
    expect(row(cleared, "cli")).toMatchObject({ selected: true, to: "0.10.0" });
    expect(cleared.press?.label).toBe("Update and Restart");
  });

  /**
   * **An explicit answer outlives the row within a visit** (review,
   * 2026-09-18). The selection's own docblock implied a stale tick could never
   * outlive its row; that is true of an ABSENT entry and not of a deliberate
   * one, and the difference had no test. It is the right behaviour — the
   * machine changing under someone is not them changing their mind — so it is
   * pinned rather than removed.
   */
  it("remembers a cleared row across a machine that changes under it", () => {
    const cleared: UpdateActSelection = { rows: { cli: false }, force: null };
    // The CLI half is behind on its own, and deliberately declined.
    const behind = act({ probe: machine(SERVER_BEHIND), selection: cleared });
    expect(row(behind, "cli")?.selected).toBe(false);
    expect(behind.press?.enabled).toBe(false);

    // The machine catches up by itself — the row has no act, so no tick, and
    // the cleared answer is not what made it so.
    const caughtUp = act({ probe: machine(), selection: cleared });
    expect(row(caughtUp, "cli")).toMatchObject({ selected: null, reason: "up to date" });

    // And falls behind again: still declined, not silently re-ticked.
    const again = act({ probe: machine(SERVER_BEHIND), selection: cleared });
    expect(row(again, "cli")?.selected).toBe(false);
  });

  it("offers Force only where a definition would actually refuse", () => {
    // § 13.2: the ONE refusal a person may overrule, and only where there is
    // one. `paneRisk` fails closed, so an unreadable definition counts.
    expect(act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES }) }).force).toEqual({
      checked: false,
      warning: expect.stringContaining("closes every subshell"),
      label: expect.stringContaining("Restart anyway"),
    });
    // A definition that spares panes has nothing to overrule.
    expect(act({ probe: machine(SERVER_BEHIND) }).force).toBeNull();
    // Neither has an act that restarts nothing: app ticked, CLI unticked.
    expect(
      act({
        probe: machine({ ...SERVER_AHEAD, ...KILLS_PANES }),
        appUpdate: APP_BEHIND,
      }).force,
    ).toBeNull();
  });

  it("carries a ticked Force into the press, and unticked is the default", () => {
    const behind = { probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES }) };
    // An override that arrives pre-accepted is not an override.
    expect(act(behind).press?.forced).toBe(false);
    expect(act({ ...behind, selection: { rows: {}, force: true } }).press?.forced).toBe(true);
  });

  it("shows phase 2 the answer phase 1 recorded, and lets a retry change it", () => {
    // § 5: the consent crosses the relaunch in the marker, so the box is
    // already ticked rather than asked for again — but a Try Again is a fresh
    // press and the box is live under it.
    const halted = {
      probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES, pendingInstall: marker({ halted: true, forced: true }) }),
    };
    expect(act(halted).force?.checked).toBe(true);
    expect(act(halted).press?.forced).toBe(true);
    expect(act({ ...halted, selection: { rows: {}, force: false } }).press?.forced).toBe(false);
  });
});

describe("the refusals of §6", () => {
  it("leaves a server this app did not install alone, and names the path", () => {
    // Writing `~/.local/bin` cannot change what a service pointing elsewhere
    // runs, so the CLI half is an update that reports success and does
    // nothing. The app half still runs.
    const view = act({
      probe: machine({
        managed: false,
        server: { argv: ["/usr/bin/subshell-server"], source: "path", version: "0.9.0" },
      }),
      appUpdate: APP_BEHIND,
    });
    expect(row(view, "cli")?.selected).toBeNull();
    expect(row(view, "cli")?.reason).toBe("not this app's");
    expect(view.notes.join(" ")).toContain("/usr/bin/subshell-server");
    expect(view.press?.kind).toBe("app");
    expect(view.press?.bundled).toBe(false);
    // And nothing restarts, so there is no refusal to overrule.
    expect(view.force).toBeNull();
  });

  it("says the source is air-gapped by name, and still offers the local half", () => {
    // The bundled-server half is entirely local, so the screen still has a job
    // on a machine that can never reach a release source. The long sentence is
    // a note; the cell says only that the check did not happen.
    const view = act({ probe: machine(SERVER_BEHIND), appUpdate: AIR_GAPPED });
    expect(view.notes.join(" ")).toContain("SUBSHELL_RELEASE_URL");
    expect(row(view, "app")?.reason).toBe("could not check");
    expect(view.press?.kind).toBe("cli");
  });

  it("does not report a source that could not answer as being up to date", () => {
    // `latest` absent WITH a reason is "we could not tell"; absent without one
    // is "nothing newer exists". Flattening the two tells a machine that has
    // not checked since it was installed that it is current.
    expect(act({ appUpdate: AIR_GAPPED }).subtitle).toContain("could not check");
    expect(act({ appUpdate: NO_APP_UPDATE }).subtitle).toContain("both current");
    // A check that threw leaves no answer at all, and says the same thing.
    expect(act({ appUpdate: null }).subtitle).toContain("could not check");
  });

  it("carries the pane question into the combined act rather than after it", () => {
    // The restart is step 2 of 2, not a separate thing to consent to after the
    // relaunch — so the box is on the screen that does the pressing.
    expect(act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES }), appUpdate: APP_BEHIND }).force).not.toBeNull();
    expect(
      act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES, pendingInstall: marker({ halted: true }) }) }).force,
    ).not.toBeNull();
  });

  it("does not call a machine current when the act failed here", () => {
    // The press path: `install_server_now` cleared the marker the moment the
    // install landed, so a restart that then failed lands on the OFFER with
    // nothing left to install. "Both current" is true of the files and false
    // of the machine, which is still running the process it had — and without
    // a press there was nothing left to try (review, 2026-09-18).
    const view = act({ finished: { ok: false } });
    expect(view.phase).toBe("idle");
    expect(view.subtitle).not.toContain("both current");
    expect(view.subtitle).toContain("restart did not finish");
    expect(view.press?.label).toBe("Try Again");
    // That Try Again IS the restart that failed, so the box it needs is there
    // even with no tickable row on screen to hang it off.
    expect(act({ probe: machine(KILLS_PANES), finished: { ok: false } }).force).not.toBeNull();
  });

  it("never offers Force where there is nothing to press", () => {
    // A warning over a machine with nothing to do is a sentence that teaches
    // people to ignore warnings.
    expect(act({ probe: machine(KILLS_PANES) }).force).toBeNull();
  });

  it("disables the press while an act is in flight, on EITHER half's flag", () => {
    // The refusal that matters is Rust's `ActionGuard`; this is the screen not
    // inviting a second press at something already running.
    //
    // Two flags, because the two halves run through different machinery
    // (review, 2026-09-18): `state` is the APP install's phases, and the CLI
    // half runs through the page's action runner, which only sets `busy`. This
    // varied `state` alone, so the property was pinned exactly on the path
    // that already had it.
    const halted = { probe: machine({ ...SERVER_BEHIND, pendingInstall: marker({ halted: true }) }) };
    for (const state of ["checking", "downloading", "installing"] as const) {
      expect(act({ ...halted, state }).press?.enabled, state).toBe(false);
    }
    expect(act({ ...halted, busy: true }).press?.enabled, "busy").toBe(false);
    expect(act(halted).press?.enabled, "idle and not busy").toBe(true);
  });
});

describe("the name", () => {
  it("is one title for one act", () => {
    // D6: the name becomes TRUE rather than being disambiguated. "Update Your
    // Server" and "Update Subshell Server" differed by a possessive, for two
    // acts; one act that updates both is honestly called this.
    expect(UPDATE_TITLE).toBe("Update Subshell Server");
  });
});

/**
 * The way out is held shut only while something is actually running (review,
 * 2026-09-18). It matters because the press DESTROYS this window on a ready
 * machine — `host.close()` reaches `open_main` through the handoff — so
 * leaving mid-install takes the progress, the failure line and the phase-2
 * screen with it.
 */
describe("leaveHeld", () => {
  it("holds the leave shut while the app download runs", () => {
    expect(leaveHeld({ busy: false, state: "downloading" })).toBe(true);
  });

  it("holds it shut while phase 2 installs and restarts", () => {
    // `act()` sets `busy` around the install-and-restart, and that is the only
    // signal phase 2 gives — the phase itself outlives the act.
    expect(leaveHeld({ busy: true, state: "idle" })).toBe(true);
  });

  it("does NOT hold it shut for a check", () => {
    // A bounded network read. Leaving during one costs nothing, and gating it
    // would make a 20-second release-list fetch feel like a lock-up.
    expect(leaveHeld({ busy: false, state: "checking" })).toBe(false);
  });

  it("releases it when nothing is running", () => {
    expect(leaveHeld({ busy: false, state: "idle" })).toBe(false);
  });

  it("releases it again after a FAILED install, rather than stranding anyone", () => {
    // The trap a gate keyed on `phase === "finishing"` would have set: a
    // marker survives a failure, so the phase stays while nothing runs.
    // `startAppUpdate`'s catch resets the state and `act`'s `finally` clears
    // `busy`, so both inputs are false again and the screen can be left.
    expect(leaveHeld({ busy: false, state: "idle" })).toBe(false);
  });

  it("holds it shut for every non-idle act state, reachable today or not", () => {
    // `installing` is unreachable from this screen — nothing sets it — but it
    // is in `ActState`, and a rule named for holding a window shut during an
    // install must not be what lets one through the day something does.
    // `checking` is the one deliberate exclusion, covered above.
    for (const state of ["downloading", "installing"] as const) {
      expect(leaveHeld({ busy: false, state })).toBe(true);
    }
  });
});
