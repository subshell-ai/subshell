import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

describe("Sheet", () => {
  afterEach(cleanup);

  it("opens from the trigger and closes from the built-in close button", () => {
    render(
      <Sheet>
        <SheetTrigger aria-label="Open navigation">☰</SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Navigation</SheetTitle>
          <nav aria-label="Main">links</nav>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Base UI keeps the popup mounted through the exit animation — it must
    // end up unmounted, matching the Radix behavior consumers rely on.
    // happy-dom runs no CSS transitions, so the unmount is synchronous.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
