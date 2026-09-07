import { afterEach, describe, expect, it } from "bun:test";
import type { ViewerPresence, ViewersState } from "@internal/subshell-protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SubshellDevices } from "@/components/subshell-devices";

function viewer(id: string, label: string, cols: number, rows: number, over: Partial<ViewerPresence> = {}) {
  return {
    id,
    label,
    capacity: { cols, rows },
    since: `2026-09-04T10:00:${id}.000Z`,
    canInput: true,
    hidden: false,
    ...over,
  } satisfies ViewerPresence;
}

const TWO: ViewersState = {
  you: "10",
  viewers: [viewer("10", "MacBook (Chrome)", 200, 60), viewer("20", "iPhone (Safari)", 80, 24)],
  sizing: { mode: "auto", pinnedViewerId: null },
};

/** Opens the menu the keyboard way — see actions-menu.test.tsx for why. */
async function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /devices watching/i }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

describe("SubshellDevices", () => {
  afterEach(cleanup);

  it("renders nothing while this is the only device", () => {
    // Alone there is nothing to explain and nothing to choose between, so the
    // control is chrome with no content.
    const { container } = render(<SubshellDevices state={{ ...TWO, viewers: [TWO.viewers[0]] }} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while the socket is down", () => {
    const { container } = render(<SubshellDevices state={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("counts the devices on the trigger", () => {
    render(<SubshellDevices state={TWO} />);
    expect(screen.getByRole("button", { name: "2 devices watching this subshell" })).toBeDefined();
  });

  it("says how big the pane is and why", async () => {
    render(<SubshellDevices state={TWO} />);
    await openMenu();
    expect(screen.getByText(/Pane is 80×24/)).toBeDefined();
    expect(screen.getByText(/sized so every device fits/)).toBeDefined();
  });

  it("names the device that is holding the pane down", async () => {
    render(<SubshellDevices state={TWO} />);
    await openMenu();
    const phone = screen.getByRole("menuitem", { name: /iPhone/ });
    expect(phone.textContent).toContain("80×24");
    expect(phone.textContent).toContain("sets size");
    // The big screen has room to spare: labelling it too would be noise.
    expect(screen.getByRole("menuitem", { name: /MacBook/ }).textContent).not.toContain("sets");
  });

  it("marks which row is this device", async () => {
    render(<SubshellDevices state={TWO} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /MacBook/ }).textContent).toContain("(this device)");
  });

  it("pins the pane to the device that was clicked", async () => {
    const calls: Array<[string, string | null | undefined]> = [];
    render(<SubshellDevices state={TWO} onSizing={(mode, id) => calls.push([mode, id])} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /MacBook/ }));
    expect(calls).toEqual([["pinned", "10"]]);
  });

  it("releases the pin when the pinned device is clicked again", async () => {
    // Without a way back, pinning would be a one-way door out of the default.
    const pinned: ViewersState = { ...TWO, sizing: { mode: "pinned", pinnedViewerId: "10" } };
    const calls: Array<[string, string | null | undefined]> = [];
    render(<SubshellDevices state={pinned} onSizing={(mode, id) => calls.push([mode, id])} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /MacBook/ }));
    expect(calls).toEqual([["auto", "10"]]);
  });

  it("offers 'Back to automatic' only while something is pinned", async () => {
    render(<SubshellDevices state={TWO} onSizing={() => {}} />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Back to automatic/ })).toBeNull();
    cleanup();

    const pinned: ViewersState = { ...TWO, sizing: { mode: "pinned", pinnedViewerId: "20" } };
    render(<SubshellDevices state={pinned} onSizing={() => {}} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /Back to automatic/ })).toBeDefined();
  });

  it("shows a view grantee the list but lets them change nothing", async () => {
    // Sizing changes what everyone sees, so it is an `edit` act — the server
    // refuses it either way; this keeps the buttons honest about it.
    render(<SubshellDevices state={TWO} />);
    await openMenu();
    const readOnly = screen.getAllByRole("menuitem").map((i) => i.getAttribute("data-disabled"));
    cleanup();

    // Asserted against the editor's rendering of the same list, so this
    // cannot pass by `data-disabled` simply never being set.
    render(<SubshellDevices state={TWO} onSizing={() => {}} />);
    await openMenu();
    const editor = screen.getAllByRole("menuitem").map((i) => i.getAttribute("data-disabled"));
    expect(readOnly.every((v) => v !== null)).toBe(true);
    expect(editor.every((v) => v === null)).toBe(true);
  });

  it("flags a read-only device in the list", async () => {
    const shared: ViewersState = {
      ...TWO,
      viewers: [TWO.viewers[0], viewer("20", "iPhone (Safari)", 80, 24, { canInput: false })],
    };
    render(<SubshellDevices state={shared} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /iPhone/ }).textContent).toContain("read-only");
  });

  it("says it is measuring rather than inventing a size", async () => {
    const early: ViewersState = {
      ...TWO,
      viewers: [viewer("10", "MacBook (Chrome)", 2, 1), viewer("20", "iPhone (Safari)", 4, 2)],
    };
    render(<SubshellDevices state={early} />);
    await openMenu();
    expect(screen.getByText("Measuring…")).toBeDefined();
  });
});

describe("SubshellDevices — who may change the sizing", () => {
  afterEach(cleanup);

  it("stays inert for a read-only viewer even when the caller offers the action", () => {
    // The caller does not decide this: a workspace pane has no access field
    // to hand, and any caller-side copy can disagree with the server. The
    // presence frame's own `canInput` on YOUR entry is the same fact the
    // server enforces, so the control reads it there.
    const readOnlyMe: ViewersState = {
      ...TWO,
      viewers: [viewer("10", "MacBook (Chrome)", 200, 60, { canInput: false }), TWO.viewers[1]],
    };
    const calls: string[] = [];
    render(<SubshellDevices state={readOnlyMe} onSizing={(mode) => calls.push(mode)} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /devices watching/i }), { key: "ArrowDown" });
    const items = screen.getAllByRole("menuitem");
    expect(items.every((i) => i.getAttribute("data-disabled") !== null)).toBe(true);
    fireEvent.click(items[0]);
    expect(calls).toEqual([]);
  });

  it("stays active when someone ELSE is the read-only one", () => {
    // Only your own entry gates the control; a guest watching read-only must
    // not disable the owner's pin.
    const guestIsReadOnly: ViewersState = {
      ...TWO,
      viewers: [TWO.viewers[0], viewer("20", "iPhone (Safari)", 80, 24, { canInput: false })],
    };
    const calls: string[] = [];
    render(<SubshellDevices state={guestIsReadOnly} onSizing={(mode) => calls.push(mode)} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /devices watching/i }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: /MacBook/ }));
    expect(calls).toEqual(["pinned"]);
  });
});
