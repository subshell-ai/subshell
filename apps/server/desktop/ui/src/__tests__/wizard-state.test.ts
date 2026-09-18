import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionResult, Probe } from "../lib/ipc";
import {
  applySupervisionChoice,
  autoSetupDecision,
  autostartSupported,
  canSetup,
  DEFAULT_SUPERVISION,
  failureLine,
  handoffView,
  isRequestedScreen,
  MIN_AUTOSTART_SERVER_VERSION,
  prereqState,
  REQUESTED_SCREENS,
  RESET_LABEL,
  recoveryAction,
  recoveryTitle,
  SETUP_TITLE,
  screenForRequest,
  screensFor,
  setupRows,
  supervisionLoginReason,
} from "../lib/wizard-state";

function virgin(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.0.0",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: null,
    platform: "darwin",
    hasBrew: true,
    onboarded: false,
    hostname: "mac",
    ...over,
  } as Probe;
}
const NO_EDITS = { port: "", host: "" };
const WITH_TMUX = { tmux: "/opt/homebrew/bin/tmux" };

const LINUX = { platform: "linux" };

/**
 * The zero-touch first run (spec 2026-09-17 § 4.1). These cases replaced the
 * four-screen journey: Welcome left because the chain now says what it does
 * by doing it, permissions left because the dashboard notices are the better
 * door (it stays on REQUESTED_SCREENS), and the dot arithmetic left with the
 * row it existed for — which is also what retired the 2026-09-12 rule that
 * showed the tmux screen on EVERY first run. A machine that already has tmux
 * no longer presses through a screen about it; the tmux screen is the one
 * unasked-to-third-party stop, and it appears exactly when tmux is missing.
 */
describe("screensFor", () => {
  it("stops a first run at tmux only while tmux is missing", () => {
    expect(screensFor(virgin(), false)).toEqual(["tmux"]);
    expect(screensFor(virgin({ ...LINUX, hasBrew: false }), false)).toEqual(["tmux"]);
    expect(screensFor(virgin(WITH_TMUX), false)).toEqual(["setup"]);
    expect(screensFor(virgin({ ...WITH_TMUX, ...LINUX }), false)).toEqual(["setup"]);
  });

  it("lists one screen, never a journey", () => {
    // The list's LENGTH is the pin: a second entry would mean the journey
    // crept back, and there is no longer anything downstream to advance
    // through it (`next()` is gone with the dots).
    for (const probe of [virgin(), virgin(WITH_TMUX), virgin({ ...WITH_TMUX, ...LINUX })]) {
      expect(screensFor(probe, false).length).toBe(1);
    }
  });

  it("holds neither Welcome nor permissions", () => {
    // Widened to `string[]` deliberately: `welcome` is no longer a member of
    // `ScreenId` at all — no render path can draw it, and no stale request
    // can name one — but the ABSENCE is only pinned while the word still
    // appears somewhere, and a plain `ScreenId[]` would not type it.
    const firstRun: string[] = screensFor(virgin(WITH_TMUX), false);
    expect(firstRun).not.toContain("permissions");
    expect(firstRun).not.toContain("welcome");
  });
});

describe("screensFor with onboarded", () => {
  it("shows exactly the recovery screen once onboarded and not ready", () => {
    for (const step of ["no-server", "unreachable", "init", "install-service", "start"] as const) {
      expect(screensFor(virgin({ ...WITH_TMUX, next: step }), true)).toEqual(["recovery"]);
    }
  });

  it("shows nothing when ready, whichever family the machine is in", () => {
    // The page opens the dashboard and this window goes; a screen list with
    // anything in it would render behind that.
    expect(screensFor(virgin({ ...WITH_TMUX, next: "ready" }), true)).toEqual([]);
    expect(screensFor(virgin({ ...WITH_TMUX, next: "ready" }), false)).toEqual([]);
  });

  it("never lists update or reset: they are entered by request", () => {
    for (const onboarded of [true, false]) {
      for (const step of ["setup", "start", "ready"] as const) {
        const screens = screensFor(virgin({ next: step }), onboarded);
        expect(screens).not.toContain("update");
        expect(screens).not.toContain("reset");
      }
    }
  });
});

/**
 * The auto-fire itself is render-path code importing Tauri, which the test
 * runner cannot load — so its shape is pinned at the source, the way
 * `config-form.test.ts` pins the wiring it cannot execute. The DECISION's
 * branches are covered by `autoSetupDecision` above; these pins are about
 * the three things only the page can get wrong: fire-once, failure-first,
 * and consulting the decision at all.
 */
describe("auto-fire, pinned at the source", () => {
  const wizard = readFileSync(join(import.meta.dir, "../wizard.ts"), "utf8");
  const at = wizard.indexOf("function renderSetup(");
  const body = wizard.slice(at, wizard.indexOf("\nfunction ", at + 1));

  it("exists, gated by the module flag and the pure decision", () => {
    expect(at, "renderSetup must exist").toBeGreaterThan(-1);
    expect(wizard).toContain("let autoFired = false;");
    expect(body).toContain("if (!autoFired &&");
    expect(body).toContain('autoSetupDecision(p, conflict, busy || running).mode === "fire"');
    // The flag is set BEFORE the chain, or a re-entrant render would see it
    // still clear and start a second chain.
    expect(body.indexOf("autoFired = true;")).toBeLessThan(body.indexOf("void startSetup();"));
  });

  it("holds fire until the port is MEASURED, so a conflicted machine gets the form, not a failed chain", () => {
    // `canSetup` treats an outstanding port check as free (a Set Up button
    // must not die for a beat per keystroke) — which is right for the button
    // and wrong for a chain nobody pressed. The page adds the knowledge the
    // pure decision is not allowed to have.
    expect(body).toContain("portKnown");
    expect(body.indexOf("const portKnown =")).toBeLessThan(body.indexOf("if (!autoFired &&"));
  });

  it("renders the failure before any re-fire — a chain that failed does not re-run itself", () => {
    // Try Again is a press; the auto path is spent. Order inside renderSetup
    // is the whole guarantee: `running` first, `failure` second, fire third.
    expect(body.indexOf("if (running)")).toBeLessThan(body.indexOf("if (failure)"));
    expect(body.indexOf("if (failure)")).toBeLessThan(body.indexOf("if (!autoFired &&"));
  });

  it("leaves Welcome unrendered and the requested-screen routing intact", () => {
    expect(wizard).not.toContain("function renderWelcome");
    // A requested screen still outranks the probe's family; `permissions`
    // lost its dual-role and the routing lost the disambiguator with it.
    expect(wizard).toContain("if (isRequestedScreen(screen)) {");
    expect(wizard).not.toContain("isRequestedScreen(screen) && !list.includes(screen)");
  });
});

describe("RESET_LABEL", () => {
  it("names what is reset, not the computer, and never ends on 'Mac'", () => {
    // Both halves were reported from a screenshot on 2026-09-12, as one bug.
    // "Reset this Mac…" reads as erasing the computer, which is nothing like
    // what this does; and a label ending on "Mac" reads as a truncated
    // "Machine", against a sibling string that really is "this machine" and
    // under the ellipsis a button that opens a screen carries.
    expect(RESET_LABEL).toBe("Reset this server");
    expect(RESET_LABEL.endsWith("Mac")).toBe(false);
    // No platform word on either side of the split: everything this app does
    // is on this machine, so saying so was only ever redundant. Subshell
    // Client's reset title is this same string — one act, one name.
    expect(RESET_LABEL).not.toContain("Machine");
    expect(RESET_LABEL).not.toContain("machine");
  });

  it("is the Reset screen's own title too, so the door and the room agree", () => {
    // The markup is static, so this is the only thing holding the two equal.
    // A button labelled one thing opening a screen titled another is its own
    // small betrayal on the one screen that may not be doubted.
    const page = readFileSync(join(import.meta.dir, "../../wizard.html"), "utf8");
    expect(page).toContain(`<p class="reset-title">${RESET_LABEL}</p>`);
  });
});

describe("recoveryTitle / recoveryAction", () => {
  it("names the step in the assistant's voice", () => {
    expect(recoveryTitle("no-server")).toBe("No Server Found");
    expect(recoveryTitle("unreachable")).toBe("Your Server Isn't Responding");
    expect(recoveryTitle("init")).toBe("Your Server Needs Its Configuration");
    expect(recoveryTitle("install-service")).toBe("Your Server Isn't Installed as a Service");
    expect(recoveryTitle("start")).toBe("Your Server Is Stopped");
  });

  it("gives the Set Up screen one name on both paths to it, naming the product", () => {
    // One act reached two ways — first run, and recovery on a machine that
    // lost its server binary — must not have two names (operator's call,
    // 2026-09-12).
    expect(recoveryTitle("setup")).toBe(SETUP_TITLE);
    expect(SETUP_TITLE).toBe("Set Up Subshell Server");
    // `not.toContain` is right for THIS string and wrong for most: it names
    // no machine at all, so either spelling is a regression. Do not copy the
    // form onto a title that legitimately says "This Machine" — that string
    // CONTAINS "Mac", and the prefix is the whole misreading. Anywhere a
    // machine word is allowed, assert where the string STOPS instead, the
    // way `recoveryTitle` is checked below.
    expect(SETUP_TITLE).not.toContain("Mac");
    expect(SETUP_TITLE).not.toContain("machine");
  });

  it("never lets a title END on 'Mac', which is what reads as truncated", () => {
    // The reported bug was a label ending on "Mac" — a prefix of the other
    // platform's own word — under an ellipsis. Every title, not one.
    const steps = ["no-server", "unreachable", "init", "install-service", "start", "setup", "ready"] as const;
    for (const step of steps) {
      expect(recoveryTitle(step).endsWith("Mac"), step).toBe(false);
    }
    expect(RESET_LABEL.endsWith("Mac")).toBe(false);
    expect(SETUP_TITLE.endsWith("Mac")).toBe(false);
  });

  it("offers one primary action per step", () => {
    expect(recoveryAction("start")).toEqual({ label: "Start", kind: "start" });
    expect(recoveryAction("install-service")).toEqual({ label: "Install and Start", kind: "install-service" });
    expect(recoveryAction("init")).toEqual({ label: "Set Up", kind: "setup" });
    expect(recoveryAction("unreachable")).toEqual({ label: "Retry", kind: "retry" });
    expect(recoveryAction("no-server")).toEqual({ label: "Choose subshell-server…", kind: "choose-binary" });
    expect(recoveryAction("setup")).toEqual({ label: "Set Up", kind: "setup" });
  });

  it("offers nothing on ready — the screen is already leaving", () => {
    expect(recoveryAction("ready")).toBeNull();
  });
});

// The `dots` tests left with the function (spec 2026-09-17 § 4.1): the row
// counted a journey, the journey is now one automatic screen, and a test for
// positions nothing renders would be a test for arithmetic that answers a
// question nobody asks.

describe("setupRows", () => {
  it("is five rows, tmux first, all pending on a virgin machine", () => {
    const rows = setupRows(virgin(), NO_EDITS);
    expect(rows.map((r) => r.id)).toEqual(["tmux", "server", "config", "service", "running"]);
    expect(rows.every((r) => !r.done)).toBe(true);
  });
  it("ticks from facts, never optimism", () => {
    const p = virgin({
      ...WITH_TMUX,
      server: { argv: ["/x/subshell-server"], source: "local-bin", version: "1.0.0" },
      status: { configEnv: { exists: true } } as never,
      service: { installed: true } as never,
      next: "start",
    });
    const done = Object.fromEntries(setupRows(p, NO_EDITS).map((r) => [r.id, r.done]));
    expect(done).toEqual({ tmux: true, server: true, config: true, service: true, running: false });
  });
  it("details name the defaults until Customize edits them", () => {
    expect(setupRows(virgin(), NO_EDITS).find((r) => r.id === "config")?.detail).toBe("port 3080, all interfaces");
    expect(setupRows(virgin(), { port: "4000", host: "127.0.0.1" }).find((r) => r.id === "config")?.detail).toBe(
      "port 4000, 127.0.0.1",
    );
  });
});

describe("canSetup", () => {
  it("refuses with a reason while no probe has answered", () =>
    expect(canSetup(null, false)).toEqual({ ok: false, reason: "Checking this machine…" }));
  it("refuses silently while busy", () => expect(canSetup(virgin(WITH_TMUX), true)).toEqual({ ok: false, reason: "" }));
  it("waits for tmux, the chain's one hard stop", () =>
    expect(canSetup(virgin(), false)).toEqual({ ok: false, reason: "Waiting for tmux" }));
  it("is ok once tmux answers, even with no server yet", () =>
    expect(canSetup(virgin(WITH_TMUX), false)).toEqual({ ok: true }));
  it("refuses a port something else is holding, and names it", () =>
    // The number is in the reason because the screen may never have been
    // customized: "Port is in use" would leave the reader to work out WHICH
    // port a form they have not opened is about to write.
    expect(canSetup(virgin(WITH_TMUX), false, { port: "3080" })).toEqual({
      ok: false,
      reason: "Port 3080 is in use",
    }));
  it("is ok when the port is free", () => expect(canSetup(virgin(WITH_TMUX), false, null)).toEqual({ ok: true }));
  it("is ok while the port answer is still outstanding", () =>
    // The whole reason unknown is `undefined` rather than a third state: the
    // check lands after the render that asked for it, and a Set Up that went
    // dead for a beat after every keystroke would look broken, not careful.
    expect(canSetup(virgin(WITH_TMUX), false, undefined)).toEqual({ ok: true }));
  it("keeps the three earlier refusals ahead of the port", () => {
    // They are about whether the question can be ASKED — no probe, an act in
    // flight, no tmux — and a screen naming a port conflict while it is still
    // waiting for its first probe would be reporting a measurement nobody
    // took. Each is passed a conflict it must ignore.
    const busy = { port: "3080" };
    expect(canSetup(null, false, busy)).toEqual({ ok: false, reason: "Checking this machine…" });
    expect(canSetup(virgin(WITH_TMUX), true, busy)).toEqual({ ok: false, reason: "" });
    expect(canSetup(virgin(), false, busy)).toEqual({ ok: false, reason: "Waiting for tmux" });
  });
});

/**
 * Whether the first run fires itself (spec 2026-09-17 § 4.2/§ 4.3). The
 * ordinary machine is the fire case — everything else is a machine that
 * earned the form, and this table is the whole of § 4.3.
 *
 * The tmux-missing row is defensive rather than lived: `screensFor` shows the
 * tmux screen while tmux is absent, so `renderSetup` never runs to ask. The
 * answer is still "form" because the ONE rule that decides — `canSetup` —
 * refuses without tmux, and a decision function that fired a chain the CLI
 * would refuse is wrong whatever the page happens to show.
 */
describe("autoSetupDecision", () => {
  const fire = { mode: "fire" as const };
  const form = { mode: "form" as const };

  it("fires on the ordinary first run: tmux present, port free, bundled server ready to install", () => {
    expect(autoSetupDecision(virgin(WITH_TMUX), null, false)).toEqual(fire);
    // "Unknown port" must NOT hold the fire — that state belongs to the
    // page, which waits for the measurement before consulting this; by the
    // time the decision is asked, absent conflict means measured free.
    expect(autoSetupDecision(virgin(WITH_TMUX), undefined, false)).toEqual(fire);
  });

  it("shows the form when something answers on the port", () => {
    // The machine that CANNOT take the default port is the machine that
    // needs the questions; auto-choosing a different one silently is the
    // "config written the user never saw" refusal.
    expect(autoSetupDecision(virgin(WITH_TMUX), { port: "3080" }, false)).toEqual(form);
  });

  it("shows the form when there is no bundled server to install", () => {
    // Dev builds with a stub sidecar, and any future asset gap: the chain has
    // nothing to install, and "Choose an existing server…" is the only way
    // forward — a button cannot press a link.
    expect(autoSetupDecision(virgin({ ...WITH_TMUX, serverChoice: "no-bundled" }), null, false)).toEqual(form);
  });

  it("shows the form while tmux is missing", () => {
    expect(autoSetupDecision(virgin(), null, false)).toEqual(form);
  });

  it("never fires while an act is in flight, or before the first probe", () => {
    // The page folds its own `running` into `busy` here; `startSetup` guards
    // the pair again because a decision is not a lock.
    expect(autoSetupDecision(virgin(WITH_TMUX), null, true)).toEqual(form);
    expect(autoSetupDecision(null, null, false)).toEqual(form);
  });

  it("fires for every other serverChoice — the exception is `no-bundled` alone", () => {
    // A machine that already has an up-to-date or adopted server still wants
    // the chain (its config, service and start are what is missing); only
    // "nothing is bundled to install" sends a first run to the form.
    expect(autoSetupDecision(virgin({ ...WITH_TMUX, serverChoice: "up-to-date" }), null, false)).toEqual(fire);
    expect(autoSetupDecision(virgin({ ...WITH_TMUX, serverChoice: "adopt-installed" }), null, false)).toEqual(fire);
    expect(autoSetupDecision(virgin({ ...WITH_TMUX, serverChoice: "upgrade-available" }), null, false)).toEqual(fire);
  });
});

describe("failureLine", () => {
  const r = (stdout: string, stderr: string): ActionResult => ({ ok: false, stdout, stderr });
  it("takes the last non-empty stderr line", () =>
    expect(failureLine(r("installing…\n", "warning: x\nrefused: no tmux on PATH\n\n"))).toBe(
      "refused: no tmux on PATH",
    ));
  it("falls back to stdout's last line", () =>
    expect(failureLine(r("step one\nstep two failed", ""))).toBe("step two failed"));
  it("has a fixed sentence when both are empty", () => expect(failureLine(r("", "  \n"))).toBe("Setup stopped."));
});

describe("prereqState", () => {
  it("found when tmux answers", () => expect(prereqState(virgin(WITH_TMUX))).toBe("found"));
  it("install where a plan exists", () => expect(prereqState(virgin({ hasBrew: true }))).toBe("install"));
  it("manual on a Mac without Homebrew", () => expect(prereqState(virgin({ hasBrew: false }))).toBe("manual"));
});

/**
 * The bug this pins (2026-09-12): pressing the dashboard's reset button
 * opened the assistant, which said "Opening your dashboard…" and
 * closed itself again.
 *
 * `screensFor` empties on a READY machine in either family, and the page
 * reads an empty list as "hand off to the dashboard and step back". Both
 * screens that are entered BY REQUEST render over a ready machine — Update
 * deep-links onto a running server, Reset is asked for from that server's own
 * dashboard — so the requested screen has to outrank the empty list. The page
 * had that rule for `update` alone, hard-coded at its one call site.
 */
describe("screens entered by request", () => {
  it("names all of them, and none is in the list of a machine that can ask", () => {
    // Five now. "How Your Server Runs" joined them in 2026-09-12, "What macOS
    // Will Ask" on 2026-09-14 and "Update Subshell Server" (the APP) on
    // 2026-09-15 — and they are different kinds of member, which is the thing
    // this test has to say out loud.
    //
    // `update` and `app-update` sit beside each other here and are about two
    // different things: `update` replaces the SERVER this app wraps,
    // `app-update` replaces the app. Both must be present, and the sorted
    // comparison is what makes dropping either one loud.
    expect([...REQUESTED_SCREENS].sort()).toEqual(["app-update", "permissions", "reset", "supervision", "update"]);
    const ready = virgin({ next: "ready", onboarded: true });
    for (const requested of REQUESTED_SCREENS) {
      // The property that matters is about the machine that can ASK: a
      // request comes from the dashboard, which exists only on an onboarded
      // machine, and an onboarded machine's list is `recovery` or empty. So a
      // requested screen can never collide with the family showing.
      expect(screensFor(ready, true)).not.toContain(requested);
      expect(screensFor(virgin({ ...WITH_TMUX, next: "start" }), true)).not.toContain(requested);
    }
  });

  it("keeps permissions request-only, and no requested screen rides a journey", () => {
    // Spec 2026-09-17 D3 took `permissions` off the macOS first run and left
    // it HERE on purpose: the dashboard's detection notices still send people
    // to the screen that explains a missing grant, and now that is its only
    // door. With no screen on both lists, the render's routing is the simple
    // `isRequestedScreen(screen)` — this is the pin that keeps it entitled to
    // be, because a screen added to BOTH lists would make "was this asked
    // for?" unreadable off the id again.
    for (const firstRun of [screensFor(virgin(), false), screensFor(virgin(WITH_TMUX), false)]) {
      for (const requested of REQUESTED_SCREENS) {
        expect(firstRun).not.toContain(requested);
      }
    }
  });

  it("outranks the ready handoff, which is the whole point", () => {
    const ready = virgin({ next: "ready", onboarded: true });
    // The list is empty, so nothing but this answer stands between a
    // requested screen and the window closing itself.
    expect(screensFor(ready, true)).toEqual([]);
    expect(isRequestedScreen("reset")).toBe(true);
    expect(isRequestedScreen("update")).toBe(true);
    expect(isRequestedScreen("app-update")).toBe(true);
    expect(isRequestedScreen("supervision")).toBe(true);
  });

  it("lets every probe-implied screen through", () => {
    for (const implied of ["tmux", "setup", "recovery"] as const) {
      expect(isRequestedScreen(implied)).toBe(false);
    }
    expect(isRequestedScreen(null)).toBe(false);
  });
});

/**
 * The two supervision boxes (spec 2026-09-12 server-supervision § 5).
 *
 * One row used to read "Start it in the background, and at every login" — one
 * sentence asserting two separate things, neither declinable. These are the
 * pure halves of making them two questions.
 */
describe("the supervision choice", () => {
  it("defaults to what the chain has always done", () => {
    expect(DEFAULT_SUPERVISION).toEqual({ background: true, autostart: true });
  });

  it("forces login off when there is no service to start", () => {
    const off = applySupervisionChoice(DEFAULT_SUPERVISION, { background: false });
    expect(off).toEqual({ background: false, autostart: false });
    // And it stays off: the box is disabled, so a press cannot reach it —
    // but a caller that tried must not be able to set a meaningless state.
    expect(applySupervisionChoice(off, { autostart: true })).toEqual({ background: false, autostart: false });
  });

  it("restores the DEFAULT when the service comes back, not the forced-off value", () => {
    const off = applySupervisionChoice(DEFAULT_SUPERVISION, { background: false });
    // Treating the forced `false` as a preference would silently opt someone
    // out of start-at-login on a press they never made.
    expect(applySupervisionChoice(off, { background: true })).toEqual({ background: true, autostart: true });
  });

  it("names the app-mode answer rather than the control above it", () => {
    // "Needs the box above" pointed at a widget. The question is real in app
    // mode too — it just has an answer the person performs themselves — and
    // this is the dashboard's sentence for it, word for word
    // (`apps/server/web/src/lib/supervision.ts`). The two screens asking the
    // same question about the same machine must not define it differently.
    const reason = supervisionLoginReason(virgin(), { background: false, autostart: false });
    expect(reason).toBe(
      "The server starts when the app does. To have it back at login, open Subshell Server at login.",
    );
  });

  it("is usable in background mode on a server new enough to have the verbs", () => {
    expect(supervisionLoginReason(virgin(), DEFAULT_SUPERVISION)).toBeNull();
  });

  it("an old server outranks the mode — it cannot honour either answer", () => {
    // The version gate is checked FIRST: on a server with no `service
    // enable`, telling someone to pick background mode instead would send
    // them to a control that still will not work.
    const old = virgin({ server: { version: "0.2.0" } } as Partial<Probe>);
    expect(supervisionLoginReason(old, DEFAULT_SUPERVISION)).toBe(
      `Needs subshell-server ${MIN_AUTOSTART_SERVER_VERSION}.`,
    );
    expect(supervisionLoginReason(old, { background: false, autostart: false })).toBe(
      `Needs subshell-server ${MIN_AUTOSTART_SERVER_VERSION}.`,
    );
  });

  it("keeps a deliberate login choice while the service stays on", () => {
    const noLogin = applySupervisionChoice(DEFAULT_SUPERVISION, { autostart: false });
    expect(noLogin).toEqual({ background: true, autostart: false });
    // Re-checking a box that was already checked is not a reset.
    expect(applySupervisionChoice(noLogin, { background: true })).toEqual({ background: true, autostart: false });
  });
});

describe("setupRows follows the choice", () => {
  const addresses = { port: "3080", host: "0.0.0.0" };
  const serviceRow = (probe: Probe, choice?: { background: boolean; autostart: boolean }) =>
    setupRows(probe, addresses, choice).find((r) => r.id === "service");

  it("names the service and whether it is armed for login", () => {
    const probe = { ...virgin(), service: { installed: true } } as unknown as Probe;
    expect(serviceRow(probe, { background: true, autostart: true })).toMatchObject({
      label: "Background service",
      detail: "starts at login",
      done: true,
    });
    expect(serviceRow(probe, { background: true, autostart: false })).toMatchObject({ detail: "not at login" });
  });

  it("names the APP when that is what will run it, and is done only once a child exists", () => {
    const app = { background: false, autostart: false };
    const notYet = { ...virgin(), supervision: "service" } as unknown as Probe;
    // A row claiming "Background service" while the chain deliberately
    // installs none would be the progress display lying about the plan.
    expect(serviceRow(notYet, app)).toMatchObject({ label: "Runs with this app", done: false });

    const running = { ...virgin(), supervision: "app", supervisor: { pid: 42 } } as unknown as Probe;
    expect(serviceRow(running, app)?.done).toBe(true);

    // The mode alone is not enough: a machine set to app mode with nothing
    // spawned has not finished this step.
    const spawnless = { ...virgin(), supervision: "app", supervisor: { pid: null } } as unknown as Probe;
    expect(serviceRow(spawnless, app)?.done).toBe(false);
  });

  it("keeps its old meaning for every caller that passes no choice", () => {
    const probe = { ...virgin(), service: { installed: true } } as unknown as Probe;
    expect(serviceRow(probe)).toMatchObject({ label: "Background service", detail: "starts at login" });
  });
});

/**
 * An OLDER installed server has no `service enable|disable` (spec § 11).
 *
 * The app's ladder adopts a newer installed copy, so a machine set up before
 * this release is driving one — and offering a login checkbox that server
 * will refuse is a control that silently does nothing.
 */
describe("autostartSupported", () => {
  it("refuses a server older than the verbs", () => {
    expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version: "0.2.0" } }))).toBe(false);
    expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version: "0.1.9" } }))).toBe(false);
    // The npm-only bumps between the last cut and the one that ships the verbs.
    expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version: "0.4.0" } }))).toBe(false);
  });

  it("accepts the version it shipped in, and anything after", () => {
    // The "after" case is DERIVED from the constant, not a literal. It used to
    // be "0.5.1", which stopped being newer the moment the constant moved to
    // 0.6.0 — a second red test for one release step, in CI, after the first
    // had already been fixed (2026-09-15).
    const [maj, min, patch] = MIN_AUTOSTART_SERVER_VERSION.split(".").map((n) => Number.parseInt(n, 10));
    const onePatchNewer = `${maj}.${min}.${(patch ?? 0) + 1}`;
    const oneMajorNewer = `${(maj ?? 0) + 1}.0.0`;
    for (const version of [MIN_AUTOSTART_SERVER_VERSION, onePatchNewer, oneMajorNewer]) {
      expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version } }))).toBe(true);
    }
  });

  it("compares numerically, so 0.10 is newer than 0.9", () => {
    expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version: "0.10.0" } }))).toBe(true);
    // The string comparison this replaces would call "0.10.0" older than
    // "0.3.0" and disable a control on a perfectly capable server.
  });

  it("assumes capable when there is no version to read", () => {
    // A server whose version string would not parse is not evidence of an old
    // one, and the CLI's own refusal — with the manager's words — is the
    // backstop that makes optimism safe here.
    expect(autostartSupported(virgin())).toBe(true);
    expect(autostartSupported(virgin({ server: { argv: ["/x"], source: "path", version: null } }))).toBe(true);
  });
});

/**
 * Routing a requested screen (spec § 6.3).
 *
 * This is the test that was missing when the bug shipped three times. The
 * page wrote the decision inline as `payload === "update" ? "update" : null`,
 * so `reset` was dropped when it was added and `supervision` was dropped when
 * IT was added — each time producing an assistant that raises, matches
 * nothing, and bounces the user back to the dashboard they pressed the button
 * on. `screenForRequest` derives it from `REQUESTED_SCREENS`, and this pins
 * that a member of that list can always be reached.
 */
describe("screenForRequest", () => {
  it("routes every screen a page may ask for", () => {
    for (const requested of REQUESTED_SCREENS) {
      expect(screenForRequest(requested)).toBe(requested);
    }
    // Named explicitly as well as by the loop: a list that lost a member
    // would make the loop above pass while the feature stayed unreachable.
    expect(screenForRequest("supervision")).toBe("supervision");
    expect(screenForRequest("update")).toBe("update");
    expect(screenForRequest("reset")).toBe("reset");
    expect(screenForRequest("permissions")).toBe("permissions");
  });

  it("answers null for home, for a probe-implied screen, and for junk", () => {
    // `home` is the Rust enum's "whatever the probe implies", which is what
    // null means here.
    expect(screenForRequest("home")).toBe(null);
    // A screen the probe owns is not something a page may request.
    expect(screenForRequest("tmux")).toBe(null);
    expect(screenForRequest("setup")).toBe(null);
    expect(screenForRequest("recovery")).toBe(null);
    // And the word Welcome no longer routes anything at all — the screen
    // left (spec 2026-09-17 D1), and a stale sender's payload must fall
    // through to "whatever the probe implies" rather than error.
    expect(screenForRequest("welcome")).toBe(null);
    // And an unknown word is ignored rather than an error, so a menu item and
    // a page can ship independently.
    expect(screenForRequest("")).toBe(null);
    expect(screenForRequest("/etc/passwd")).toBe(null);
  });
});

/**
 * `MIN_AUTOSTART_SERVER_VERSION` is history, not a projection.
 *
 * The two autostart verbs shipped in **server-v0.9.0** — that tag carries
 * `api/admin-server/autostart.route.ts` (verified against the tag,
 * 2026-09-18) — so the constant stays `0.9.0` for as long as the app
 * supports that release, and no future bump changes the fact.
 *
 * This test used to compare the constant AGAINST the server package and
 * require it to be no older — sound only while the verbs were UNRELEASED,
 * because then the constant named the next cut and a rival changeset
 * jumping that cut ahead of the verbs was the hazard worth catching. The
 * moment server-v0.9.0 was published, every later package bump made that
 * comparison fire a FALSE alarm: the only way to satisfy it was to raise
 * the constant, which would have the assistant refuse autostart on working
 * 0.9.0 installs — trading a red test for a real bug.
 *
 * What stays checkable from the checkout: the constant must never name a
 * version the server package has not reached. A MIN ahead of the shipping
 * code is the one direction that is always wrong.
 */
describe("MIN_AUTOSTART_SERVER_VERSION", () => {
  it("names the release the verbs actually shipped in", () => {
    // Frozen fact, not a moving target: server-v0.9.0 shipped the verbs.
    // Changing this line is a claim about release history — check the tag.
    expect(MIN_AUTOSTART_SERVER_VERSION).toBe("0.9.0");
  });

  it("never names a version the server package has not reached", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../api/package.json"), "utf8")) as {
      version: string;
    };
    const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
    const [min, server] = [parts(MIN_AUTOSTART_SERVER_VERSION), parts(pkg.version)];
    let verdict = 0;
    for (let i = 0; i < Math.max(min.length, server.length) && verdict === 0; i += 1) {
      verdict = (min[i] ?? 0) - (server[i] ?? 0);
    }
    expect(verdict).toBeLessThanOrEqual(0);
  });
});

describe("handoffView", () => {
  // The waiting variant (2026-09-14's "a run you watched must end on a
  // screen you dismiss") left with the press it waited for: spec 2026-09-17
  // § 4.2 fires the chain itself, so nobody chose to watch a run, and the
  // handoff is only the moment its title already names.
  it("hands off by itself, in both families", () => {
    const onboarded = handoffView({ onboarded: true });
    expect(onboarded.title).toBe("Your Server Is Running");
    expect(onboarded.subtitle).toBe("Opening your dashboard…");
    const firstRun = handoffView({ onboarded: false });
    expect(firstRun.title).toBe("Setting Up Subshell…");
    expect(firstRun.subtitle).toBe("Opening your dashboard…");
  });

  it("names the machine's family, not the window's history", () => {
    // The title split survives because the SENTENCES differ: a first run is
    // finishing; an onboarded machine whose server came back was never
    // setting anything up.
    expect(handoffView({ onboarded: true }).title).not.toBe(handoffView({ onboarded: false }).title);
  });
});
