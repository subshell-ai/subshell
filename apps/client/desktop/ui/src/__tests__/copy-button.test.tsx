/**
 * The copy affordance.
 *
 * The case worth the file is the third one: `apps/server/desktop` needed a
 * whole page-state module (`lib/copy-flash.ts`) to keep its tick alive, because
 * its assistant rebuilds `#content` every 1500 ms while the flash lasts 1600 —
 * so a state carried by the element was thrown away after a random fraction of
 * its life. This page is React and re-RENDERS rather than rebuilding, which is
 * why that module was not ported; a re-render mid-flash is exactly what proves
 * it, so it is asserted rather than assumed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyButton } from "@/components/ui/copy-button";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own. That is exactly
// how the Welcome screen's "Continue is the only control" case passed on a Mac
// and failed on CI, counting four About-screen buttons as its own (2026-09-18).
afterEach(cleanup);

const REAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, "clipboard");

/** What `navigator.clipboard.writeText` does for the rest of this test. */
function clipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  if (REAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", REAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
});

describe("the copy button", () => {
  it("copies the value and says so, since the glyph says nothing to a screen reader", async () => {
    const copied: string[] = [];
    clipboard(async (text) => {
      copied.push(text);
    });
    render(<CopyButton value="brew install tmux" label="the Homebrew command" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy the Homebrew command" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "the Homebrew command copied" })).toBeTruthy());
    expect(copied).toEqual(["brew install tmux"]);
  });

  it("keeps its tick across a re-render — the defect the other app needed a module for", async () => {
    clipboard(async () => {});
    const view = render(<CopyButton value="brew install tmux" label="the Homebrew command" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy the Homebrew command" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "the Homebrew command copied" })).toBeTruthy());
    // What the poll does to this screen, twice, well inside the flash.
    view.rerender(<CopyButton value="brew install tmux" label="the Homebrew command" />);
    view.rerender(<CopyButton value="brew install tmux" label="the Homebrew command" />);
    expect(screen.getByRole("button", { name: "the Homebrew command copied" })).toBeTruthy();
  });

  // A press that flashed nothing would read as one that did not register, and
  // the clipboard really can refuse — a non-secure context, a policy.
  it("says it could not copy when the clipboard refuses", async () => {
    clipboard(async () => {
      throw new Error("denied");
    });
    render(<CopyButton value="sudo port install tmux" label="the MacPorts command" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy the MacPorts command" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Could not copy the MacPorts command" })).toBeTruthy(),
    );
  });

  it("copies what it is showing now, not what it was built with", async () => {
    const copied: string[] = [];
    clipboard(async (text) => {
      copied.push(text);
    });
    const view = render(<CopyButton value="brew install tmux" label="the command" />);
    view.rerender(<CopyButton value="sudo port install tmux" label="the command" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy the command" }));
    await waitFor(() => expect(copied).toEqual(["sudo port install tmux"]));
  });
});
