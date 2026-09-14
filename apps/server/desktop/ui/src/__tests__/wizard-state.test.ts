import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionResult, Probe } from "../lib/ipc";
import {
  applySupervisionChoice,
  autostartSupported,
  canSetup,
  DEFAULT_SUPERVISION,
  dots,
  failureLine,
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

describe("screensFor", () => {
  it("shows the tmux screen on every first run, installed or not", () => {
    // It used to be filtered out when tmux was present, and the skip was
    // invisible in the worst way: `dots` positions by `FIRST_RUN.indexOf`, so
    // the flow jumped from dot 1 to dot 3 and a prerequisite the product
    // depends on was satisfied without ever being named.
    expect(screensFor(virgin(), false)).toEqual(["welcome", "tmux", "setup"]);
    expect(screensFor(virgin(WITH_TMUX), false)).toEqual(["welcome", "tmux", "setup"]);
  });

  it("keeps the dots continuous on a machine that already has tmux", () => {
    // The property the skip broke: every screen of the run has the dot its
    // position implies, with no gap for the reader to explain to themselves.
    const withTmux = virgin(WITH_TMUX);
    const list = screensFor(withTmux, false);
    expect(list.map((s) => dots(withTmux, s).current)).toEqual([0, 1, 2]);
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

describe("dots", () => {
  it("always has six positions, so the row does not grow when the SPA takes over", () =>
    expect(dots(virgin(), "welcome").total).toBe(6));
  it("counts a skipped tmux screen as done", () => {
    expect(dots(virgin(WITH_TMUX), "setup")).toEqual({ total: 6, done: 2, current: 2 });
    expect(dots(virgin(WITH_TMUX), "welcome")).toEqual({ total: 6, done: 0, current: 0 });
  });
  it("walks the three when tmux is missing", () => {
    expect(dots(virgin(), "tmux")).toEqual({ total: 6, done: 1, current: 1 });
    expect(dots(virgin(), "setup")).toEqual({ total: 6, done: 2, current: 2 });
  });
  it("has no position at all for the screens outside the first run", () => {
    // Recovery, Update and Reset are not steps on a journey, so the row is
    // hidden rather than shown with nothing filled. A negative `current` is
    // what the renderer hides on.
    for (const screen of ["recovery", "update", "reset"] as const) {
      expect(dots(virgin(), screen)).toEqual({ total: 6, done: -1, current: -1 });
    }
  });
});

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
  it("names all of them, and none is ever in a probe's list", () => {
    // Three now: "How Your Server Runs" joined them (spec 2026-09-12
    // server-supervision), and it is the same kind of screen — a question a
    // PERSON asks, which no probe ever implies.
    expect([...REQUESTED_SCREENS].sort()).toEqual(["reset", "supervision", "update"]);
    const ready = virgin({ next: "ready", onboarded: true });
    for (const requested of REQUESTED_SCREENS) {
      expect(screensFor(ready, true)).not.toContain(requested);
      expect(screensFor(virgin(), false)).not.toContain(requested);
    }
  });

  it("outranks the ready handoff, which is the whole point", () => {
    const ready = virgin({ next: "ready", onboarded: true });
    // The list is empty, so nothing but this answer stands between a
    // requested screen and the window closing itself.
    expect(screensFor(ready, true)).toEqual([]);
    expect(isRequestedScreen("reset")).toBe(true);
    expect(isRequestedScreen("update")).toBe(true);
    expect(isRequestedScreen("supervision")).toBe(true);
  });

  it("lets every probe-implied screen through", () => {
    for (const implied of ["welcome", "tmux", "setup", "recovery"] as const) {
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
  });

  it("accepts the version it shipped in, and anything after", () => {
    for (const version of [MIN_AUTOSTART_SERVER_VERSION, "0.3.1", "1.0.0"]) {
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
  });

  it("answers null for home, for a probe-implied screen, and for junk", () => {
    // `home` is the Rust enum's "whatever the probe implies", which is what
    // null means here.
    expect(screenForRequest("home")).toBe(null);
    // A screen the probe owns is not something a page may request.
    expect(screenForRequest("welcome")).toBe(null);
    expect(screenForRequest("recovery")).toBe(null);
    // And an unknown word is ignored rather than an error, so a menu item and
    // a page can ship independently.
    expect(screenForRequest("")).toBe(null);
    expect(screenForRequest("/etc/passwd")).toBe(null);
  });
});

/**
 * The desktop constant tracks the CLI that grew the verbs it needs.
 *
 * `MIN_AUTOSTART_SERVER_VERSION` is the version `service enable|disable`
 * shipped in, and nothing else ties it to the server package. The hazard is
 * ORDERING rather than typos: if another `@internal/server` minor changeset
 * merges first, the server releases without those verbs at the version this
 * constant names, and the login checkbox goes live against a server that will
 * refuse it. This turns that from silent into a red test at the moment it
 * becomes wrong.
 */
describe("MIN_AUTOSTART_SERVER_VERSION", () => {
  it("is not older than the server package it refers to", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../api/package.json"), "utf8")) as {
      version: string;
    };
    const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
    const [min, server] = [parts(MIN_AUTOSTART_SERVER_VERSION), parts(pkg.version)];
    let verdict = 0;
    for (let i = 0; i < Math.max(min.length, server.length) && verdict === 0; i += 1) {
      verdict = (min[i] ?? 0) - (server[i] ?? 0);
    }
    expect(verdict).toBeGreaterThanOrEqual(0);
  });
});
