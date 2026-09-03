import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Pencil, Square, Trash2 } from "lucide-react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";

const ITEMS: ActionItem[] = [
  { label: "Edit", icon: Pencil, onSelect: () => {} },
  { label: "Terminate", icon: Square, onSelect: () => {} },
  { label: "Delete", icon: Trash2, destructive: true, onSelect: () => {} },
];

/**
 * Opens the menu the keyboard way (Radix dropdown triggers open on
 * pointerdown, which happy-dom cannot emulate, but ArrowDown is equivalent)
 * and settles once its items are painted. The await flushes Radix's async
 * popper-position update inside act, keeping the console free of
 * "not wrapped in act" noise.
 */
async function openMenu(label: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${label}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

describe("ActionsMenu", () => {
  afterEach(cleanup);

  it("labels the trigger with the entity so every menu reads the same", () => {
    render(<ActionsMenu label="web" items={ITEMS} />);
    expect(screen.getByRole("button", { name: "Actions for web" })).toBeDefined();
  });

  it("reveals every action on click", async () => {
    render(<ActionsMenu label="web" items={ITEMS} />);
    await openMenu("web");
    for (const item of ITEMS) {
      expect(screen.getByRole("menuitem", { name: item.label })).toBeDefined();
    }
  });

  it("runs the item's action and closes the menu", async () => {
    let fired = 0;
    render(<ActionsMenu label="web" items={[{ label: "Terminate", icon: Square, onSelect: () => fired++ }]} />);
    await openMenu("web");
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminate" }));
    expect(fired).toBe(1);
    // Radix unmounts menu content on close — gone items are what make the
    // next click land on the card instead of a stale item.
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });

  it("marks destructive items so they render in the destructive colour", async () => {
    render(<ActionsMenu label="web" items={ITEMS} />);
    await openMenu("web");
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-destructive");
  });

  it("gates the trigger when disabled", () => {
    render(<ActionsMenu label="web" items={ITEMS} disabled />);
    // A disabled button receives no real clicks or keys at all, so asserting
    // the attribute is the faithful check — fireEvent would bypass it.
    expect((screen.getByRole("button", { name: "Actions for web" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Context mode (spec 2026-09-03): children replace the ⋯ button — the menu
 * opens on RIGHT-CLICK of the wrapped subtree, anchored at the cursor by
 * Base UI's ContextMenu.
 */
describe("ActionsMenu — context mode (children)", () => {
  afterEach(cleanup);

  it("renders the wrapped element verbatim — no ⋯ button", () => {
    render(
      <ActionsMenu label="web" items={ITEMS}>
        <a href="/x">row link</a>
      </ActionsMenu>,
    );
    expect(screen.getByText("row link")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Actions for web" })).toBeNull();
  });

  it("right-click opens the menu and choosing an item runs its onSelect", async () => {
    let fired = 0;
    render(
      <ActionsMenu label="web" items={[{ label: "Terminate", icon: Square, onSelect: () => fired++ }]}>
        <a href="/x">row link</a>
      </ActionsMenu>,
    );
    fireEvent.contextMenu(screen.getByText("row link"));
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminate" }));
    expect(fired).toBe(1);
  });
});
