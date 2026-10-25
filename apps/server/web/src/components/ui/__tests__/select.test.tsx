import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

describe("Select control density and shared popup rows", () => {
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

  it("uses the same compact height for form controls and popup rows", async () => {
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
    expect(trigger.className.includes("h-7")).toBe(true);
    expect(trigger.className.includes("text-detail")).toBe(true);
    const item = document.querySelector('[data-slot="select-item"]');
    expect(item?.className.includes("text-detail")).toBe(true);
    expect(item?.className.includes("py-0.5")).toBe(true);
    expect(item?.className.includes("min-h-7")).toBe(true);
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
