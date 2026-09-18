/**
 * The one update act's whole decision (spec 2026-09-18 § 4, § 6).
 *
 * This file is where the screen is actually covered. `ui/src/__tests__/` has
 * no DOM harness — nothing here can mount `wizard.ts` — so a judgment left in
 * the render is a judgment with no test at all, and the point of
 * `lib/update-act.ts` is that every one of them is here instead.
 *
 * What it pins, in the order the spec states it: the four cases of § 4.1 (app
 * behind, server behind, both, neither), the two phases of § 4.2 across the
 * relaunch, and each refusal of § 6 — a server this app did not install, an
 * air-gapped source, and an act already in flight.
 */
import { describe, expect, it } from "bun:test";
import type { AppUpdateCheck, PendingInstall, Probe } from "../lib/ipc";
import { UPDATE_TITLE, type UpdateActInput, updateAct } from "../lib/update-act";

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

function act(over: Partial<UpdateActInput> = {}) {
  return updateAct({ probe: machine(), appUpdate: NO_APP_UPDATE, state: "idle", finished: null, ...over });
}

/** The row for one half, or undefined when the screen does not state it. */
const row = (view: ReturnType<typeof act>, id: "app" | "cli") => view.rows.find((r) => r.id === id);

describe("the four cases of §4.1", () => {
  it("states both halves when both are behind, and the server's target is unknown", () => {
    const view = act({ probe: machine(SERVER_BEHIND), appUpdate: APP_BEHIND });
    expect(view.phase).toBe("idle");
    expect(row(view, "app")).toEqual({ id: "app", label: "Subshell Server app", from: "0.8.0", to: "0.8.1" });
    // `to: null` is the honest answer rather than a missing row: a desktop
    // release manifest carries the component's version and its asset digests,
    // never the version of the CLI inside the bundle (§ 4.3). The number
    // appears after the relaunch, and the screen says "the server it ships"
    // until then.
    expect(row(view, "cli")).toEqual({ id: "cli", label: "subshell-server CLI", from: "0.9.0", to: null });
    expect(view.press).toEqual({ label: "Download and Install 0.8.1", kind: "app", enabled: true });
  });

  it("still states the server half when only the APP is behind", () => {
    // The app ships the server, so the act always installs one — even from a
    // machine whose server is current, where the NEW bundle's copy is newer
    // than what is here. A screen that showed the app row alone would be
    // describing half of what its own button does.
    const view = act({ appUpdate: APP_BEHIND });
    expect(row(view, "app")?.to).toBe("0.8.1");
    expect(row(view, "cli")).toEqual({ id: "cli", label: "subshell-server CLI", from: "0.10.0", to: null });
  });

  it("names both numbers when only the SERVER is behind, and does not relaunch", () => {
    // The case with no phase 2: the app is current, so the bundled server it
    // already carries is installed here and now, and its target version is a
    // number this build knows.
    const view = act({ probe: machine(SERVER_BEHIND) });
    expect(row(view, "app")).toBeUndefined();
    expect(row(view, "cli")).toEqual({ id: "cli", label: "subshell-server CLI", from: "0.9.0", to: "0.10.0" });
    expect(view.press).toEqual({ label: "Update and Restart", kind: "cli", enabled: true });
  });

  it("offers nothing when neither is behind", () => {
    const view = act();
    expect(view.rows).toEqual([]);
    expect(view.press).toBeNull();
    expect(view.subtitle).toContain("both current");
  });

  it("treats a machine with no server installed as work the act can do", () => {
    // `install-bundled` is the first install, not a refusal: nothing is
    // resolved, so nothing is being overwritten and the app owns what it
    // writes. It is reachable here through the boot resume on a machine whose
    // server was removed between the press and the relaunch.
    const view = act({ probe: machine({ serverChoice: "install-bundled", server: null, managed: false }) });
    expect(row(view, "cli")).toEqual({ id: "cli", label: "subshell-server CLI", from: "not installed", to: "0.10.0" });
    expect(view.press?.kind).toBe("cli");
  });

  it("offers nothing for a server NEWER than the one this app ships", () => {
    // `adopt-installed`: boot's migrator is forward-only, so a newer installed
    // server is adopted and never overwritten. Offering it here would be the
    // one downgrade this product treats as data loss.
    const view = act({
      probe: machine({
        serverChoice: "adopt-installed",
        server: { argv: ["/home/u/.local/bin/subshell-server"], source: "local-bin", version: "0.11.0" },
      }),
    });
    expect(view.rows).toEqual([]);
    expect(view.press).toBeNull();
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

  it("outranks every phase-1 question, including a release answer already in hand", () => {
    // The check's answer is about an app that has just been replaced. Letting
    // it render would offer a download over a machine mid-install.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }), appUpdate: APP_BEHIND });
    expect(view.phase).toBe("finishing");
    expect(view.rows).toEqual([]);
  });

  it("offers Try Again when the finishing install failed here", () => {
    const view = act({
      probe: machine({ ...SERVER_BEHIND, pendingInstall: marker() }),
      finished: { ok: false },
    });
    expect(view.phase).toBe("finishing");
    expect(view.press).toEqual({ label: "Try Again", kind: "cli", enabled: true });
  });

  it("stops firing by itself once the attempts are spent, and says what is running", () => {
    // The one place this design refuses to keep trying on someone's behalf: a
    // failure on every boot would otherwise take the window to a failure screen
    // on every launch, forever.
    const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker({ halted: true }) }) });
    expect(view.phase).toBe("halted");
    expect(view.press).toEqual({ label: "Try Again", kind: "cli", enabled: true });
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
    expect(row(view, "cli")).toBeUndefined();
    expect(view.notes.join(" ")).toContain("/usr/bin/subshell-server");
    expect(view.press?.kind).toBe("app");
    // And nothing restarts, so the pane warning has nothing to warn about.
    expect(view.paneWarning).toBe(false);
  });

  it("says the source is air-gapped by name, and still offers the local half", () => {
    // The bundled-server half is entirely local, so the screen still has a job
    // on a machine that can never reach a release source.
    const view = act({ probe: machine(SERVER_BEHIND), appUpdate: AIR_GAPPED });
    expect(view.notes.join(" ")).toContain("SUBSHELL_RELEASE_URL");
    expect(view.press?.kind).toBe("cli");
    expect(row(view, "app")).toBeUndefined();
  });

  it("does not report a source that could not answer as being up to date", () => {
    // `latest` absent WITH a reason is "we could not tell"; absent without one
    // is "nothing newer exists". Flattening the two tells a machine that has
    // not checked since it was installed that it is current.
    expect(act({ appUpdate: AIR_GAPPED }).subtitle).toContain("could not check");
    expect(act({ appUpdate: NO_APP_UPDATE }).subtitle).toContain("both current");
  });

  it("warns about live panes wherever the act restarts the service", () => {
    // `unknown` counts as unsafe for the same reason `paneRisk` does: the
    // warning that turns out to be unnecessary costs a sentence, and the one
    // that was needed and absent costs someone's running sessions.
    expect(act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES }) }).paneWarning).toBe(true);
    expect(act({ probe: machine(SERVER_BEHIND) }).paneWarning).toBe(false);
    // It carries into the combined act: the restart is step 2 of 2, not a
    // separate thing to be consented to after the relaunch.
    expect(act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES }), appUpdate: APP_BEHIND }).paneWarning).toBe(true);
    // And onto the phase-2 screen, where a Try Again is the fresh consent.
    expect(
      act({ probe: machine({ ...SERVER_BEHIND, ...KILLS_PANES, pendingInstall: marker({ halted: true }) }) })
        .paneWarning,
    ).toBe(true);
  });

  it("never warns where there is nothing to press", () => {
    // A warning over a machine with nothing to do is a sentence that teaches
    // people to ignore warnings.
    expect(act({ probe: machine(KILLS_PANES) }).paneWarning).toBe(false);
  });

  it("disables the press while an act is in flight", () => {
    // The refusal that matters is Rust's `ActionGuard`; this is the screen not
    // inviting a second press at something already running.
    for (const state of ["checking", "downloading", "installing"] as const) {
      const view = act({ probe: machine({ ...SERVER_BEHIND, pendingInstall: marker({ halted: true }) }), state });
      expect(view.press?.enabled, state).toBe(false);
    }
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
