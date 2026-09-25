/**
 * **What macOS Will Ask**, as component tests: the rows the model computes
 * per permission state, the two asks and their discarded results, the System
 * Settings door, and the Back/Continue split by `permissionsAfterHandoff`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { ActionResult } from "../../lib/ipc";
import { PermissionsScreen } from "../permissions-screen";

afterEach(cleanup);

const STRINGS = {
  title: "What macOS Will Ask",
  subtitle: "Three things, each once. Here is what they are for.",
  problem: "",
};

/** A held `act`, so an in-flight row's spinner state is observable. */
const heldAct = vi.fn((_fn: () => Promise<ActionResult | null>) => new Promise<void>(() => {}));

function renderPermissions(over: {
  probe?: ReturnType<typeof makeProbe>;
  afterHandoff?: boolean;
  act?: (fn: () => Promise<ActionResult | null>) => Promise<void>;
  fail?: (err: unknown) => void;
  onContinue?: () => void;
  onClose?: () => void;
}) {
  return render(
    <PermissionsScreen
      strings={STRINGS}
      probe={over.probe ?? makeProbe({ notificationPermission: "not-determined", photosPermission: "not-determined" })}
      busy={false}
      running={false}
      afterHandoff={over.afterHandoff ?? false}
      act={over.act ?? heldAct}
      fail={over.fail ?? (() => {})}
      onContinue={over.onContinue ?? (() => {})}
      onClose={over.onClose ?? (() => {})}
    />,
  );
}

describe("the rows", () => {
  it("asks where macOS has not yet, and says so with the app's own words", () => {
    renderPermissions({});
    // The visible word is the bare "Allow" (operator's call, 2026-09-25), but
    // the ACCESSIBLE name carries the row's permission — a button list sees
    // no rows — so the roles below stay distinguishable, which is also what
    // pins the aria-label onto both buttons.
    const allowNotifications = screen.getByRole("button", { name: "Allow Notifications" });
    const allowPhotos = screen.getByRole("button", { name: "Allow Photos" });
    expect(allowNotifications.className).toContain("primary");
    expect(allowPhotos.textContent).toBe("Allow");
    // The Files row is unreadable by design and never asks.
    expect(screen.getByText("Asked later")).toBeDefined();
    // The Files row's door is where a refusal is undone, whatever macOS has
    // asked yet.
    expect(screen.getByRole("button", { name: "Open Files and Folders settings" })).toBeDefined();
  });

  it("marks an allowed permission done, with the checklist's own tick", () => {
    renderPermissions({ probe: makeProbe({ notificationPermission: "authorized", photosPermission: "authorized" }) });
    expect(screen.queryAllByRole("button", { name: /^Allow/ })).toHaveLength(0);
    const rows = document.querySelectorAll("ul.checklist li");
    expect(rows[0].getAttribute("data-state")).toBe("done");
    expect(rows[2].getAttribute("data-state")).toBe("done");
  });

  it("sends a denied permission to System Settings, the one way back", () => {
    const fail = vi.fn();
    renderPermissions({
      probe: makeProbe({ notificationPermission: "denied", photosPermission: "denied" }),
      fail,
    });
    const doors = screen.getAllByRole("button", { name: /^Open .* settings$/ });
    // Three rows, two denials, one always-there Files door — each names its
    // own pane in its accessible name.
    expect(doors).toHaveLength(3);
  });

  it("spins the row whose sheet is up, and discards the result — the probe is the one source", async () => {
    // `act` surfaces a rejection on the problem line; the stub mirrors that
    // instead of leaving an unhandled rejection behind.
    const act = vi.fn((fn: () => Promise<ActionResult | null>) =>
      fn().then(
        () => undefined,
        () => undefined,
      ),
    );
    const probe = makeProbe({ notificationPermission: "not-determined", photosPermission: "not-determined" });
    const view = renderPermissions({ probe, act });
    // The in-flight flag: the row renders from the MODEL's answer for a
    // requesting row, which is "active" — observable as the state attribute
    // while the act is unresolved.
    screen.getByRole("button", { name: "Allow Notifications" }).click();
    await Promise.resolve();
    expect(act).toHaveBeenCalledTimes(1);
    const row = document.querySelectorAll("ul.checklist li")[0];
    expect(row.getAttribute("data-state")).toBe("active");
    view.unmount();
    // The flags reset with the visit (the component unmounted above), as the
    // old page-local scope always implied — so this fresh render's press
    // starts the ask again rather than being refused by a stale flag. The
    // guard that would refuse a press DURING an act is `busy`, held false
    // here so the flag's own reset is what is under test.
    renderPermissions({ probe, act });
    screen.getByRole("button", { name: "Allow Notifications" }).click();
    expect(act).toHaveBeenCalledTimes(2);
  });
});

describe("the two doors", () => {
  it("continues to the dashboard from the ready handoff, and closes from everywhere else", () => {
    const onContinue = vi.fn();
    renderPermissions({ afterHandoff: true, onContinue });
    // From the handoff there is no Back: the window's whole remaining job is
    // to open the dashboard.
    expect(screen.queryByRole("button", { name: /^Back$/ })).toBeNull();
    screen.getByRole("button", { name: "Continue" }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("takes the leave's own word from the probe, not from the door", () => {
    const onClose = vi.fn();
    // A mid-journey machine has a screen behind this one, so the leave reads Back.
    renderPermissions({ probe: makeProbe({ next: "start" }), onClose });
    screen.getByRole("button", { name: "Back" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
