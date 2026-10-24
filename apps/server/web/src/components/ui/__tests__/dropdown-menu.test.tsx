import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The popup must clamp to the viewport's available height and scroll within
 * it, the way the Select and Combobox popups do. A menu that grows past the
 * screen gets clipped, not scrollable — items below the fold are unreachable,
 * and a box taller than the viewport can't even flip to the other side (the
 * library only avoids collision when the box CAN fit). The Radix→Base UI
 * migration is how this clamp was once lost; this pin is what keeps the next
 * one from losing it again. The subshell actions menu is the surface that
 * showed the cut-off, but the fix and the pin live on the shared wrapper.
 */
describe("DropdownMenuContent height clamp", () => {
  afterEach(cleanup);

  it("clamps the popup to the available height and lets it scroll", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuItem>Two</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    // Base UI triggers open on pointerdown, which happy-dom cannot emulate;
    // the keyboard path is equivalent (same posture as subshell-actions-menu).
    fireEvent.keyDown(screen.getByRole("button", { name: "Open" }), { key: "ArrowDown" });
    // Boolean asserts in polls: expect(element).toBeNull() makes bun serialize
    // the whole DOM graph on a failed attempt and can wedge the update the
    // poll is waiting for (web AGENTS.md).
    await waitFor(() => expect(document.querySelector('[data-slot="menu-content"]') !== null).toBe(true));
    const popup = document.querySelector('[data-slot="menu-content"]');
    expect(popup?.className.includes("max-h-[var(--available-height)]")).toBe(true);
    expect(popup?.className.includes("overflow-y-auto")).toBe(true);
  });
});
