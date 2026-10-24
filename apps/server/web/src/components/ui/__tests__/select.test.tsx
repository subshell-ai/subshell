import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The picker's sizing rule: a popup is the size of the control it hangs off.
 * The sidebar's workspace switcher shipped a 28px trigger whose popup opened
 * with the full-size 32px rows — the list outran the picker that opened it
 * (phone report 2026-10-24). `density="compact"` on the Root sizes both
 * halves; the default stays the form-family pair (h-9 control, 32px row,
 * the row height the action menus use). The trigger's own className override
 * is what made the halves drift, so the pin checks both sides together.
 */
describe("Select density pairing", () => {
  afterEach(cleanup);

  async function openPicker(label: string) {
    const trigger = screen.getByTestId(`trigger-${label}`);
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    if (!document.querySelector('[data-slot="select-content"]')) {
      // Base UI opens Select on pointerdown, which happy-dom cannot emulate;
      // the keyboard path is equivalent (same posture as dropdown-menu.test).
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    }
    // Boolean asserts in polls: expect(element).toBeNull() makes bun serialize
    // the whole DOM graph and can wedge the update the poll waits for.
    await waitFor(() => expect(document.querySelector('[data-slot="select-content"]') !== null).toBe(true));
    return trigger;
  }

  it("keeps the default picker on the form-family sizes", async () => {
    render(
      <Select items={[{ value: "a", label: "Alpha" }]} value="a">
        <SelectTrigger data-testid="trigger-default" aria-label="Default picker">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = await openPicker("default");
    expect(trigger.className.includes("h-9")).toBe(true);
    expect(trigger.className.includes("text-sm")).toBe(true);
    const item = document.querySelector('[data-slot="select-item"]');
    expect(item?.className.includes("text-sm")).toBe(true);
    expect(item?.className.includes("py-1.5")).toBe(true);
  });

  it("sizes a compact picker's rows to its compact control", async () => {
    render(
      <Select density="compact" items={[{ value: "a", label: "Alpha" }]} value="a">
        <SelectTrigger data-testid="trigger-compact" aria-label="Compact picker" className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = await openPicker("compact");
    expect(trigger.className.includes("h-7")).toBe(true);
    expect(trigger.className.includes("text-detail")).toBe(true);
    expect(trigger.className.includes("h-9")).toBe(false);
    const item = document.querySelector('[data-slot="select-item"]');
    expect(item?.className.includes("text-detail")).toBe(true);
    expect(item?.className.includes("py-1.5")).toBe(false);
  });
});
