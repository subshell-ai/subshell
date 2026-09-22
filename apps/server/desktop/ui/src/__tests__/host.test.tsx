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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("does not route the handoff, or open the dashboard, before the pending-screen pull resolves", async () => {
    // The probe answers immediately (ready machine); the pull is HELD. This
    // is exactly the window the old comment describes: the probe is in, the
    // request is not yet.
    const pending = deferred<string | null>();
    fake = installFakeIpc({
      probe: makeProbe({ next: "ready", onboarded: true }),
      handlers: { desktop_pending_screen: () => pending.promise, desktop_open_main: () => undefined },
    });
    const { container } = render(<Host />);

    await waitFor(() => expect(routeOf()).toBe("boot"));
    // The route is still `boot` with a ready probe in hand: the gate, not
    // the machine, is what the window is waiting on.
    expect(routeOf()).toBe("boot");
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
    expect(container).toBeDefined();
    pending.resolve("reset");

    // The pull resolves to a reset request: the requested screen applies,
    // and the handoff never happened.
    await waitFor(() => expect(routeOf()).toBe("reset"));
    expect(fake.callsTo("desktop_open_main")).toHaveLength(0);
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

  it("runs the chain: a fresh meter per press, a re-arm on the second press, and a fresh first run after the machine answers", async () => {
    const armCalls: unknown[] = [];
    const resetCalls: string[] = [];
    fake = installFakeIpc({
      probe: RESETTABLE,
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: (args) => {
          armCalls.push(args);
          return true;
        },
        desktop_reset: (args) => {
          resetCalls.push(args.typed as string);
          return { ok: true, stdout: "", stderr: "" };
        },
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    // The screen is up from the request, before the plan arms (the old open()
    // showed first for exactly this reason).
    await waitFor(() => expect(document.getElementById("reset-confirm")).not.toBeNull());
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(1);

    typeHostname("testhost");
    screen.getByRole("button", { name: "Reset everything" }).click();
    await waitFor(() => expect(resetCalls).toEqual(["testhost"]));
    // The press RE-ARMS before it resets — arm #2 is the run's own, on top of
    // the screen's arming (#1): `plan` is the page's own first row, and the
    // arming round trip is its content.
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(2);

    // The machine answered: the page's fired-already latch and any pre-reset
    // failure describe a machine that no longer exists, so a fresh first-run
    // probe is met with a fresh welcome once the screen is dismissed — the
    // observable half of `rearmFirstRun` (the latch it clears is the same
    // call the welcome's auto-fire reads).
    fake.setProbe(makeProbe({ next: "init", onboarded: false, tmux: "/usr/bin/tmux" }));

    // Re-arm on EVERY press: the plan is one-shot by design, and a second
    // press that skipped it would answer "no reset plan is staged".
    screen.getByRole("button", { name: "Reset everything" }).click();
    await waitFor(() => expect(resetCalls).toHaveLength(2));
    expect(fake.callsTo("desktop_arm_reset")).toHaveLength(3);

    screen.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() => expect(routeOf()).toBe("welcome"));
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
    // reset
    fake = installFakeIpc({
      probe: cases[2][0],
      handlers: {
        desktop_pending_screen: () => "reset",
        desktop_arm_reset: () => true,
        desktop_open_main: () => undefined,
      },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("reset"));
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

  it("carries the Reset door in the rail, and its room stays frame-replacing", async () => {
    // Operator ruling 2026-09-22: the DOOR moves into the rail; the SCREEN
    // keeps its "only thing happening" premise — no rail, no bar — because
    // that is the design that leaves no way out from under the chain.
    fake = installFakeIpc({
      probe: makeProbe({ onboarded: true, next: "start" }),
      handlers: { desktop_pending_screen: () => null, desktop_arm_reset: () => true },
    });
    render(<Host />);
    await waitFor(() => expect(routeOf()).toBe("status"));
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeNull();
    // The bar's ghost is gone — the rail carries the door now.
    expect(screen.queryByRole("button", { name: "Reset this server…" })).toBeNull();
    screen.getByRole("button", { name: "Reset" }).click();
    await waitFor(() => expect(routeOf()).toBe("reset"));
    // The room replaces the frame: no navigation, and the hostname gate is there.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(document.getElementById("reset-confirm")).not.toBeNull();
  });

  it("renders the leave buttons only where the rail is not", async () => {
    // With the rail, Back/Close answer a question the rail already answers.
    // Without it — a requested screen over a mid-first-run machine — they are
    // still the only way out.
    // With rail: the requested update on a ready machine has NO Close, and
    // nobody is stranded — Status is the way back, held for a human press.
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
    await waitFor(() => expect(routeOf()).toBe("handoff"));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
    screen.getByRole("button", { name: "Continue" }).click();
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

  it("HOLDS the handoff a Status select lands on, on a ready machine", async () => {
    // A deliberate rail select is not an arrival: the auto-continue rule was
    // written for windows reopened over a running server, which owe no result
    // to a reader. Selecting Status while driving this window must render the
    // ready view HELD — Continue available, no dashboard opening by itself.
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
    await waitFor(() => expect(routeOf()).toBe("handoff"));
    // Held: the waiting arm renders its Continue, and nothing has opened.
    // The words are pinned too — the held surface claiming an open that is
    // being withheld was the reviewer's finding.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your Server Is Running");
    expect(screen.getByText("Your dashboard opens when you press Continue. Nothing opens by itself.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
    expect(fake?.callsTo("desktop_open_main")).toHaveLength(0);
    // The press IS the human the hold was waiting for.
    screen.getByRole("button", { name: "Continue" }).click();
    await waitFor(() => expect(fake?.callsTo("desktop_open_main")).toHaveLength(1));
  });
});
