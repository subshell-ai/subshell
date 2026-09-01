import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KEY_BAR_BUTTONS, TerminalKeyBar } from "@/components/terminal-key-bar";

describe("TerminalKeyBar", () => {
  afterEach(cleanup);

  it("maps every button to its exact bytes", () => {
    const table = Object.fromEntries(KEY_BAR_BUTTONS.map((b) => [b.aria, b.bytes]));
    expect(table).toEqual({
      "Send Escape": "\x1b",
      "Send Ctrl-C": "\x03",
      "Send Shift-Tab": "\x1b[Z",
      "Send Tab": "\t",
      "Send Enter": "\r",
      "Insert newline": "\x1b\r",
      "Send slash": "/",
      "Send arrow left": "\x1b[D",
      "Send arrow up": "\x1b[A",
      "Send arrow down": "\x1b[B",
      "Send arrow right": "\x1b[C",
    });
  });

  it("clicking a byte button sends exactly that sequence", () => {
    const sent: string[] = [];
    render(<TerminalKeyBar disabled={false} onBytes={(b) => sent.push(b)} />);
    fireEvent.click(screen.getByRole("button", { name: "Send Ctrl-C" }));
    fireEvent.click(screen.getByRole("button", { name: "Send arrow up" }));
    // "/" is a plain byte like every other key — the pane's own program
    // (shell, claude slash commands, …) decides what it means.
    fireEvent.click(screen.getByRole("button", { name: "Send slash" }));
    expect(sent).toEqual(["\x03", "\x1b[A", "/"]);
  });

  it("cancels pointerdown so taps never steal focus from the terminal", () => {
    render(<TerminalKeyBar disabled={false} onBytes={() => {}} />);
    for (const btn of screen.getAllByRole("button")) {
      // preventDefault on a cancelable pointerdown keeps focus on the
      // terminal's input textarea; without it the button focuses on tap and
      // subsequent hardware keys stop reaching the pane.
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      btn.dispatchEvent(down);
      expect(down.defaultPrevented, btn.getAttribute("aria-label") ?? "?").toBe(true);
    }
  });

  it("is inert while disabled", () => {
    let clicks = 0;
    render(<TerminalKeyBar disabled onBytes={() => clicks++} />);
    for (const btn of screen.getAllByRole("button")) fireEvent.click(btn);
    expect(clicks).toBe(0);
  });

  it("shows no image button without onPickImage, and a working one with it", () => {
    const { unmount } = render(<TerminalKeyBar disabled={false} onBytes={() => {}} />);
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    unmount();

    let picked = 0;
    render(<TerminalKeyBar disabled={false} onBytes={() => {}} onPickImage={() => picked++} />);
    const img = screen.getByRole("button", { name: "Attach image" });
    fireEvent.click(img);
    expect(picked).toBe(1);
  });

  it("the image button is disabled with the rest of the bar", () => {
    render(<TerminalKeyBar disabled onBytes={() => {}} onPickImage={() => {}} />);
    const img = screen.getByRole("button", { name: "Attach image" }) as HTMLButtonElement;
    expect(img.disabled).toBe(true);
  });
});
