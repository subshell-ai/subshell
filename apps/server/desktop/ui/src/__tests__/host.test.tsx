/**
 * The host's boot gate and screen ratchet, as component tests.
 *
 * Two behaviors here were the review's findings on the port, both of them
 * sequencing rules the old page's single-threaded render got for free:
 *
 * - **The boot gate.** The old page rendered NOTHING between the probe and
 *   the pendingScreen pull, so nothing could slip between them and take the
 *   ready handoff. A React `setProbe` flushes a render, so without gating the
 *   route on the boot flag, a window opened FOR reset or update on a ready
 *   machine would route the handoff first — the latch would fire and the
 *   dashboard would open before the requested screen applied.
 * - **The ratchet.** The old render overwrote its `screen` with its
 *   resolution, so a corrected screen stayed corrected even after the probe
 *   changed again.
 *
 * The route is observable through the placeholder's `data-route` attribute,
 * which exists only until Task 8's screens land (see host.tsx).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { Host } from "../host";
import type { Probe } from "../lib/ipc";
import { deferred, type FakeIpc, installFakeIpc, makeProbe } from "./harness";

// One document per bun test process: a file that renders without unmounting
// leaves its DOM for whatever file shards into that process next (the same
// rule the client app's app.test.tsx records).
afterEach(cleanup);

let fake: FakeIpc | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const routeOf = (): string | null => document.querySelector("[data-route]")?.getAttribute("data-route") ?? null;

describe("the host's boot gate", () => {
  it("opens the requested reset as a DIALOG, and never opens the dashboard", async () => {
    // The probe answers immediately (ready machine); the pull is HELD. This
    // is exactly the window the old comment describes: the probe is in, the
    // request is not yet.
    const pending = deferred<string | null>();
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: {
        desktop_pending_screen: () => pending.promise,
        desktop_arm_reset: () => true,
        desktop_open_main: () => undefined,
      },
    });
    const { container } = render(<Host />);

    await waitFor(() => expect(routeOf()).toBe("boot"));
    // The route is still `boot` with a ready probe in hand: the gate, not
    // the machine, is what the window is waiting on.
    expect(routeOf()).toBe("boot");
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
    expect(container).toBeDefined();
    pending.resolve("reset");

    // The pull resolves to a reset request. Since the 2026-09-23 dialog
    // ruling the request opens a modal rather than naming a screen: the
    // ready handoff renders UNDERNEATH it (the route resolves as if nothing
    // had been asked for), and the auto-open effect's `resetOpen` gate is
    // what keeps the dashboard from opening out from under the confirmation.
    // `booted` and `resetOpen` flip in one batch (both writes land before
    // the flush), so the guard is up for the handoff's first render.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reset this server" })).toBeTruthy());
    expect(routeOf()).toBe("handoff");
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
  });

  it("opens the reset dialog over a machine mid-first-run (issue #232)", async () => {
    // The tray's Reset press reaches this path on a machine that has NEVER
    // been onboarded — the exact case every in-app door refused. The dialog
    // is armed by the same `desktop_arm_reset` the dashboard card uses; what
    // this pins is that no journey-stage gate stands between the request and
    // the confirmation, because the wrong-machine install is the case the
    // door exists for.
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: false, next: "init", tmux: "/usr/bin/tmux" }),
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: () => true,
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reset this server" })).toBeTruthy());
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
    // The first-run journey underneath is untouched: no rail, no standing
    // screen; the dialog simply sits on top of whatever the machine owes.
    expect(routeOf()).toBe("welcome");
  });

  it("routes the handoff and opens the dashboard once the pull answers with nothing", async () => {
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: { desktop_pending_screen: () => null, desktop_open_main: () => undefined },
    });
    render(<Host />);

    // After boot, the ready machine hands off and auto-opens — the positive
    // control for the gate above.
    await waitFor(() => expect(routeOf()).toBe("handoff"));
    await waitFor(() => expect(fake?.callsTo("desktop_open_main")).toHaveLength(1));
  });
});

describe("the host's correction ratchet", () => {
  it("never drags a requested screen onto the journey, however stale the machine's list", async () => {
    // The ratchet only ever corrects a NON-requested screen (the old render
    // returned inside its requested arm). A mid-first-run machine whose list
    // is [welcome, tmux], asked for `update`, stays on Update.
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: false, next: "init", tmux: null }),
      handlers: { desktop_pending_screen: () => "update" },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("update"));
  });

  it("arms the tray's Open Server App onto the standing Status screen, and never opens the dashboard", async () => {
    // The tray's "Open Server App" word is "status"; applyScreen maps it onto
    // the standing Status marker (the ScreenId the rail's Status select sets).
    // On a READY machine it must render the facts screen WITHOUT handing off —
    // otherwise open_main_now closes the window this press just opened, the very
    // bug the door exists to avoid. A bare open would land here as `null` and
    // bounce; Status does not.
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: { desktop_pending_screen: () => "status", desktop_open_main: () => undefined },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("status"));
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
  });

  // The ratchet's POSITIVE arm — a corrected screen persisting when the
  // corrected screen re-enters the list later — needs a screen a PRESS sets
  // (`go`), and no screen exists to press until Task 3. Its arithmetic is
  // pinned by `resolveJourney`'s unit tests in lib/__tests__/route.test.ts;
  // this file gains the component case with the first screen that navigates.
});

describe("the host's reset chain", () => {
  /** A ready machine whose server reports its data locations: the resettable case. */
  const RESETTABLE = makeProbe({
    next: "start",
    hostname: "testhost",
    status: {
      configEnv: { path: "/Users/u/.config/subshell-server/config.env", exists: true },
      paths: {
        dataDir: "/Users/u/.local/share/subshell-server",
        database: "/Users/u/.local/share/subshell-server/db.sqlite",
        logsDir: "/Users/u/.local/share/subshell-server/logs",
        nodeArtifacts: "/Users/u/.local/share/subshell-server/node-artifacts",
      },
      listen: { port: 3080, listening: true },
    },
  } as never);

  const typeHostname = (value: string): void => {
    fireEvent.change(document.getElementById("reset-confirm") as HTMLInputElement, { target: { value } });
  };

  it("runs the chain: a half-run keeps the dialog with its log and Retry, a success closes it to a fresh first run", async () => {
    const resetCalls: string[] = [];
    let chainOk = false;
    fake = installFakeIpc({
      probe: RESETTABLE,
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: () => true,
        desktop_reset: (args) => {
          resetCalls.push(args.typed as string);
          // Press one fails half-run; the Retry press succeeds.
          return chainOk ? { ok: true, stdout: "", stderr: "" } : { ok: false, stdout: "", stderr: "bootout refused" };
        },
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    // The dialog is up from the request, before the plan arms (the old open()
    // showed first for exactly this reason), over the recovery section the
    // broken machine implies.
    await waitFor(() => expect(document.getElementById("reset-confirm")).not.toBeNull());
    expect(routeOf()).toBe("status");
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(1);

    typeHostname("testhost");
    screen.getByRole("button", { name: "Reset everything" }).click();
    await waitFor(() => expect(resetCalls).toEqual(["testhost"]));
    // The press RE-ARMS before it resets — arm #2 is the run's own, on top of
    // the dialog's arming (#1): `plan` is the page's own first row, and the
    // arming round trip is its content.
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(2);

    // A HALF-RUN stays open where the human is: the log and the promoted
    // Retry are the chain's receipt, and the dialog is the room.
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry reset" })).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "Resetting this server" })).toBeTruthy();

    // Re-arm on EVERY press: the plan is one-shot by design, and a second
    // press that skipped it would answer "no reset plan is staged".
    chainOk = true;
    screen.getByRole("button", { name: "Retry reset" }).click();
    await waitFor(() => expect(resetCalls).toHaveLength(2));
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(3);

    // The machine answered: the page's fired-already latch and any pre-reset
    // failure describe a machine that no longer exists, so the completed
    // chain CLOSES the dialog (the client's completed-reset rule) and the
    // fresh first-run probe underneath is the receipt — the observable half
    // of `rearmFirstRun` (the latch it clears is the same call the welcome's
    // auto-fire reads).
    fake.setProbe(makeProbe({ next: "init", onboarded: false, tmux: "/usr/bin/tmux" }));
    // Flush the chain's promise continuations under act before asserting the
    // dialog closed: a `waitFor` whose first check throws escapes happy-dom's
    // retry on Linux CI.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The chain's own trailing refresh can land before the test's `setProbe`
    // (the fake answers immediately), so the welcome underneath arrives on
    // the page's own 1500 ms poll — the same clock the operator watches. Drive
    // that poll to term INSIDE act rather than `waitFor` it: a `waitFor` whose
    // first check fails and whose mutation comes from a later out-of-act timer
    // is the shape that escapes happy-dom's retry on Linux CI. A 1600 ms flush
    // lets the 1500 ms poll fire under act, then the assertion is direct.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    });
    expect(routeOf()).toBe("welcome");
  });

  it("promotes the run label to Retry and renders the half-run log as a failure", async () => {
    fake = installFakeIpc({
      probe: RESETTABLE,
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: () => true,
        desktop_reset: () => ({ ok: false, stdout: "", stderr: "launchctl bootout exited 5" }),
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(document.getElementById("reset-confirm")).not.toBeNull());
    typeHostname("testhost");
    screen.getByRole("button", { name: "Reset everything" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry reset" })).toBeDefined());
    // The half-run's verbatim log, reading as a failure.
    const log = document.querySelector("pre.pane-pre.mt-3") as HTMLPreElement;
    expect(log.textContent).toBe("launchctl bootout exited 5");
    expect(log.className).toContain("output-bad");
  });
});

/**
 * StrictMode double-fires every mount effect in dev, and the host has two
 * arms that ACT on the page's behalf rather than only draw: the setup chain's
 * auto-fire and the update act's phase-2 auto-resume. The state latch each
 * sets is written asynchronously, so the second invocation would pass the
 * same guard and start a second act — the host latches them synchronously,
 * and these two tests are that latch's regression pins. They mount the WHOLE
 * page under StrictMode (the app entry does) and count the CLI command each
 * chain runs.
 */
describe("the acting arms under StrictMode", () => {
  it("resumes the update act ONCE across the double effect", async () => {
    // A machine booted mid-update: the marker says phase 1 ran and the
    // consent was given, so the screen's presence alone resumes phase 2.
    fake = installFakeIpc({
      probe: makeProbe({
        next: "ready",
        onboarded: true,
        pendingInstall: { fromAppVersion: "0.12.0", forced: true, halted: false },
      }),
      handlers: {
        desktop_pending_screen: () => "update",
        desktop_install_server: () => ({ ok: true, stdout: "", stderr: "" }),
        desktop_service: () => ({ ok: true, stdout: "", stderr: "" }),
      },
    });
    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    await waitFor(() => expect(fake?.callsTo("desktop_install_server")).toHaveLength(1));
    // The second invocation sees `resumeFired` still clear (the state write is
    // async), so only the synchronous ref latch stands between it and a
    // second install.
    await new Promise((r) => setTimeout(r, 100));
    expect(fake?.callsTo("desktop_install_server")).toHaveLength(1);
  });

  it("auto-fires the setup chain ONCE when the port answer is already cached", async () => {
    // The cached-answer shape is the one that double-fires: the fire effect's
    // mount double-run both see a port answer in hand. To cache one BEFORE
    // the setup screen mounts, the ask is held in flight while the journey
    // corrects setup away (tmux disappears), and it lands while nobody is on
    // the screen — the page's cached answer, nobody to act on it. Three
    // probe corrections ride the poll's own 1500 ms.
    const port = deferred<{ inUse: boolean }>();
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: false, next: "setup", tmux: null }),
      handlers: {
        desktop_pending_screen: () => null,
        desktop_port_in_use: () => port.promise,
        desktop_setup: () => ({ ok: true, stdout: "", stderr: "" }),
      },
    });
    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    await waitFor(() => expect(routeOf()).toBe("welcome"));
    screen.getByRole("button", { name: "Continue" }).click();
    await waitFor(() => expect(routeOf()).toBe("tmux"));
    // The tmux gate lifts: the correction lands the journey on setup, whose
    // first render asks about the port — and the answer is held.
    fake?.setProbe(makeProbe({ onboarded: false, next: "setup", tmux: "/opt/homebrew/bin/tmux" }));
    await waitFor(() => expect(routeOf()).toBe("setup"), { timeout: 5000 });
    // The tmux gate drops again: setup leaves with its ask still in flight.
    fake?.setProbe(makeProbe({ onboarded: false, next: "setup", tmux: null }));
    await waitFor(() => expect(routeOf()).toBe("tmux"), { timeout: 5000 });
    // The answer lands, cached free, with the screen gone. Then the gate
    // lifts for good: setup remounts ONTO the cached answer, and the fire
    // effect's mount double-run both see it.
    port.resolve({ inUse: false });
    fake?.setProbe(makeProbe({ onboarded: false, next: "setup", tmux: "/opt/homebrew/bin/tmux" }));
    await waitFor(() => expect(routeOf()).toBe("setup"), { timeout: 5000 });
    await waitFor(() => expect(fake?.callsTo("desktop_setup")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(fake?.callsTo("desktop_setup")).toHaveLength(1);
  });
});

/**
 * The rail's wiring (spec 2026-09-21; plan Task 10): present on the four
 * standing sections of an onboarded machine, absent everywhere the FTE rule
 * and the two frame-replacing screens say full-window, routing on select.
 */
describe("the rail", () => {
  it("shows the Status section active on the recovery screen", async () => {
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: true, next: "start" }),
      handlers: { desktop_pending_screen: () => null },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("status"));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).toBeDefined();
    expect(screen.getByRole("button", { name: "Update" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("true");
  });

  it("marks the active section on each requested standing screen", async () => {
    for (const [request, active] of [
      ["update", "Update"],
      ["supervision", "Service"],
      ["settings", "Addresses"],
    ] as const) {
      fake = installFakeIpc({
        probe: makeProbe({ next: "ready", onboarded: true }),
        handlers: {
          desktop_pending_screen: () => request,
          desktop_check_app_update: () => ({ current: "0.12.1", latest: null, notes: null, reason: null }),
        },
      });
      render(<Host />);
      // The `settings` wire word routes to the `addresses` kind — Server
      // Addresses keeps its name off the route kind, as it always has.
      await waitFor(() => expect(routeOf()).toBe(request === "settings" ? "addresses" : request));
      expect(screen.getByRole("button", { name: active }).getAttribute("aria-current")).toBe("true");
      cleanup();
      fake?.restore();
      fake = undefined;
    }
  });

  it("is absent on every full-window screen", async () => {
    const cases: [Probe, () => Promise<void>][] = [
      // welcome: a machine mid-first-run, no request
      [makeProbe({ onboarded: false, next: "setup" }), async () => waitFor(() => expect(routeOf()).toBe("welcome"))],
      // the progress checklist: the chain runs over a ready machine
      [
        makeProbe({ next: "ready", onboarded: true }),
        async () => {
          // the running flag is host state, not probe — the route test pins the
          // kind; here the ready handoff stands in for the family
          await waitFor(() => expect(routeOf()).toBe("handoff"));
        },
      ],
      // reset and permissions: frame-replacing
      [makeProbe({ next: "ready", onboarded: true }), async () => {}],
      // boot: the probe is still landing
      [makeProbe({ next: "ready", onboarded: true }), async () => {}],
    ];
    // welcome
    fake = installFakeIpc({ probe: cases[0][0], handlers: { desktop_pending_screen: () => null } });
    render(<Host />);
    await cases[0][1]();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    cleanup();
    fake?.restore();
    // handoff
    fake = installFakeIpc({
      probe: cases[1][0],
      handlers: { desktop_pending_screen: () => null, desktop_open_main: () => undefined },
    });
    render(<Host />);
    await cases[1][1]();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    cleanup();
    fake?.restore();
    // reset: the deep link opens the DIALOG over the ready handoff (ruling
    // 2026-09-23), and the handoff underneath is rail-less like every
    // arrival. The dialog itself is the room; its own case is the dedicated
    // test below, off a hanging desktop_reset.
    fake = installFakeIpc({
      probe: cases[2][0],
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: () => true,
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reset this server" })).toBeTruthy());
    expect(routeOf()).toBe("handoff");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    cleanup();
    fake?.restore();
    // permissions
    fake = installFakeIpc({
      probe: cases[2][0],
      handlers: { desktop_pending_screen: () => "permissions", desktop_open_main: () => undefined },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("permissions"));
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    cleanup();
    fake?.restore();
    // boot: hold the pending-screen pull, as the boot-gate test does
    const pending = deferred<string | null>();
    fake = installFakeIpc({
      probe: cases[3][0],
      handlers: { desktop_pending_screen: () => pending.promise, desktop_open_main: () => undefined },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("boot"));
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    pending.resolve(null);
  });

  it("is absent for a requested screen over a machine mid-first-run", async () => {
    // The old page let a requested update render over a first run; wave 2
    // keeps the render and takes away the rail — the exclusion keys on the
    // machine's journey, not on who asked.
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: false, next: "setup", tmux: "/opt/homebrew/bin/tmux" }),
      handlers: {
        desktop_pending_screen: () => "update",
        desktop_check_app_update: () => ({ current: "0.12.1", latest: null, notes: null, reason: null }),
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("update"));
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("routes on section select, and Status resolves to the machine's state", async () => {
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: true, next: "start" }),
      handlers: { desktop_pending_screen: () => null },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("status"));
    screen.getByRole("button", { name: "Update" }).click();
    await waitFor(() => expect(routeOf()).toBe("update"));
    expect(screen.getByRole("button", { name: "Update" }).getAttribute("aria-current")).toBe("true");
    screen.getByRole("button", { name: "Status" }).click();
    await waitFor(() => expect(routeOf()).toBe("status"));
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("true");
  });

  it("carries the Reset door in the rail, and its dialog overrides nothing", async () => {
    // Operator ruling 2026-09-23 (the client's shape, ported): the DOOR is in
    // the rail, and selecting it opens a DIALOG over the standing section —
    // no route moves, no highlight moves, and the overlay itself is the room
    // the old frame-replacing screen was: while the chain runs, Escape and
    // the backdrop are inert and Cancel is disabled, so there is no way out
    // from under it.
    const gate = deferred<{ ok: boolean }>();
    // The plan needs a complete `paths` block (the same shape the chain
    // test's RESETTABLE carries), or the dialog refuses and the room has
    // nothing to run into.
    const resettable = makeProbe({
      next: "start",
      hostname: "testhost",
      status: {
        configEnv: { path: "/Users/u/.config/subshell-server/config.env", exists: true },
        paths: {
          dataDir: "/Users/u/.local/share/subshell-server",
          database: "/Users/u/.local/share/subshell-server/db.sqlite",
          logsDir: "/Users/u/.local/share/subshell-server/logs",
          nodeArtifacts: "/Users/u/.local/share/subshell-server/node-artifacts",
        },
        listen: { port: 3080, listening: true },
      },
    } as never);
    fake = installFakeIpc({
      probe: resettable,
      handlers: {
        desktop_pending_screen: () => null,
        desktop_arm_reset: () => true,
        desktop_reset: () => gate.promise,
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("status"));
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeNull();
    // The bar's ghost is gone — the rail carries the door now.
    expect(screen.queryByRole("button", { name: "Reset this server…" })).toBeNull();
    screen.getByRole("button", { name: "Reset" }).click();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reset this server" })).toBeTruthy());
    // OVERRIDES NOTHING: the recovery section stands underneath, Status keeps
    // the highlight, and the dialog arms on open.
    expect(routeOf()).toBe("status");
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("true");
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(1);
    // typeHostname is the chain test's local; the same act, spelled out here.
    fireEvent.change(document.getElementById("reset-confirm") as HTMLInputElement, {
      target: { value: "testhost" },
    });
    // The transitions settle off promise continuations (the runner's busy
    // flip, then the gate), where waitFor's observer retry escapes under
    // happy-dom on Linux CI. Flush under act and assert the settled DOM.
    await act(async () => {
      screen.getByRole("button", { name: "Reset everything" }).click();
    });
    // The room is the chain: the pane retitled, the dismissal is inert, and
    // a Cancel press cannot end it.
    expect(screen.getByRole("dialog", { name: "Resetting this server" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      gate.resolve({ ok: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    // A completed chain closes the dialog; the section underneath is where
    // the person left it, and the rail answers again.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeOf()).toBe("status");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("true");
  });

  it("renders the leave buttons only where the rail is not", async () => {
    // With the rail, Back/Close answer a question the rail already answers.
    // Without it — a requested screen over a mid-first-run machine — they are
    // still the only way out.
    // With rail: the requested update on a ready machine has NO Close, and
    // nobody is stranded — Status is the way back, and since the 2026-09-23
    // ruling it is a real screen whose one button opens the dashboard on the
    // press (the old route resolved onto the handoff and its Continue).
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: {
        desktop_pending_screen: () => "update",
        desktop_check_app_update: () => ({ current: "0.12.1", latest: null, notes: null, reason: null }),
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("update"));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    screen.getByRole("button", { name: "Status" }).click();
    await waitFor(() => expect(routeOf()).toBe("status"));
    expect(screen.getByRole("button", { name: "Open control plane" })).toBeDefined();
    screen.getByRole("button", { name: "Open control plane" }).click();
    await waitFor(() => expect(fake?.callsTo("desktop_open_main")).toHaveLength(1));
    cleanup();
    fake?.restore();

    // Without rail: the exclusion case keeps its leave button.
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: false, next: "setup", tmux: "/opt/homebrew/bin/tmux" }),
      handlers: {
        desktop_pending_screen: () => "update",
        desktop_check_app_update: () => ({ current: "0.12.1", latest: null, notes: null, reason: null }),
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("update"));
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeNull();
  });

  it("discards a screen's draft when the person leaves through the rail", async () => {
    // With Back gone from the rail-bearing screens, a select is the only
    // exit — and a draft that survived it would read as the machine's
    // configuration. The form re-seeds from the machine on the next visit.
    fake = installFakeIpc({
      probe: makeProbe({
        next: "start",
        onboarded: true,
        status: { settings: { SERVER_PORT: { value: "4000", source: "configured" } } },
      }),
      handlers: { desktop_pending_screen: () => "settings" },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("addresses"));
    const port = () => document.getElementById("field-port") as HTMLInputElement;
    expect(port().value).toBe("4000");
    port().focus();
    port().value = "5000";
    port().dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(port().value).toBe("5000");
    screen.getByRole("button", { name: "Service" }).click();
    await waitFor(() => expect(routeOf()).toBe("supervision"));
    screen.getByRole("button", { name: "Addresses" }).click();
    await waitFor(() => expect(routeOf()).toBe("addresses"));
    // Re-seeded from the machine: the typed 5000 is gone.
    expect(port().value).toBe("4000");
  });

  it("shows a REAL status screen when Status is selected on a running machine, and opens nothing by itself", async () => {
    // Operator ruling 2026-09-23 (the bounce the setup pane was objected to):
    // a deliberate rail select is not an arrival. The old route resolved the
    // select onto the handoff on a ready machine — a screen titled "Opening
    // Your Dashboard…" held back by a flag. Now the select stands the window
    // on the Status section proper: the machine's facts, the log tail, the
    // app's version, and ONE button.
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: {
        desktop_pending_screen: () => "update",
        desktop_check_app_update: () => ({ current: "0.12.1", latest: null, notes: null, reason: null }),
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("update"));
    screen.getByRole("button", { name: "Status" }).click();
    await waitFor(() => expect(routeOf()).toBe("status"));
    // The running view's words — a standing title, not a handoff's promise.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your Server Is Running");
    expect(screen.getByText("Everything the server reports is below.")).toBeDefined();
    // The section's own content: the facts (app + CLI versions first), the log.
    expect(screen.getByText("Server log")).toBeDefined();
    expect(screen.getByText("This app")).toBeDefined();
    expect(screen.getByText("Subshell Server 0.12.1")).toBeDefined();
    // One button, and NOTHING opened by itself: no Continue, no auto-open.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(fake?.callsTo("desktop_open_main")).toHaveLength(0);
    // Status holds the highlight while it stands.
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("true");
  });

  it("still hands off, and opens the dashboard, when the window ARRIVES on a running machine", async () => {
    // The select stopped bouncing; the ARRIVAL still hands off — a window
    // reopened over a running server owes no result to a reader. This is the
    // same auto-open the boot-gate suite's positive control pins; here it is
    // the pair that keeps the new status branch from swallowing arrival
    // (screen null) along with the select (screen "recovery").
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: {
        desktop_pending_screen: () => null,
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("handoff"));
    await waitFor(() => expect(fake?.callsTo("desktop_open_main")).toHaveLength(1));
  });
});
