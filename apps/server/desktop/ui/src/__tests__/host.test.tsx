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
import { cleanup, render, waitFor } from "@testing-library/react";
import { Host } from "../host";
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
