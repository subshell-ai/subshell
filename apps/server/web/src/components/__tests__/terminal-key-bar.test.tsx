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

  it("splits the keys across two rows with the image button trailing the second", () => {
    // One row of twelve squished the glyphs on a phone — the layout contract
    // is: control keys on top, input/arrows/image below.
    render(<TerminalKeyBar disabled={false} onBytes={() => {}} onPickImage={() => {}} />);
    const escRow = screen.getByRole("button", { name: "Send Escape" }).parentElement;
    const enterRow = screen.getByRole("button", { name: "Send Enter" }).parentElement;
    const slashRow = screen.getByRole("button", { name: "Send slash" }).parentElement;
    const imgRow = screen.getByRole("button", { name: "Attach image" }).parentElement;
    expect(enterRow).toBe(escRow); // controls stay together
    expect(slashRow).not.toBe(escRow); // arrows/slash moved down
    expect(imgRow).toBe(slashRow);
  });

  it("shows no scroll buttons without handlers, and working ones with them", () => {
    const { unmount } = render(<TerminalKeyBar disabled={false} onBytes={() => {}} />);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
    unmount();

    let top = 0;
    let bottom = 0;
    render(
      <TerminalKeyBar disabled={false} onBytes={() => {}} onScrollTop={() => top++} onScrollBottom={() => bottom++} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    expect([top, bottom]).toEqual([1, 1]);
  });

  it("scroll buttons stay live while the rest of the bar is disabled", () => {
    // They drive the LOCAL xterm scrollback — no socket needed, so the
    // pre-attach/reconnecting gray-out must not eat them.
    let jumps = 0;
    let sent = 0;
    render(<TerminalKeyBar disabled onBytes={() => sent++} onScrollTop={() => jumps++} />);
    fireEvent.click(screen.getByRole("button", { name: "Send Ctrl-C" }));
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    expect(sent).toBe(0); // byte keys honor `disabled` as before
    expect(jumps).toBe(1);
  });

  it("a readOnly (view) bar ships only the scroll jumps — no byte keys, no image picker", () => {
    let jumps = 0;
    render(
      <TerminalKeyBar
        disabled={false}
        readOnly
        onBytes={() => {
          throw new Error("a view grantee must not see byte keys");
        }}
        onPickImage={() => {
          throw new Error("a view grantee must not see the image picker");
        }}
        onScrollTop={() => jumps++}
        onScrollBottom={() => jumps++}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send Ctrl-C" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    expect(jumps).toBe(2);
  });

  it("bottom-pads by HALF the home-indicator inset, both modes", () => {
    // The full inset read as a dead card band under the keys (operator:
    // "huge bottom padding"); half keeps the 44 pt buttons clear of the
    // indicator's centre. Pinned at the class level because happy-dom
    // resolves no env() — the behavior itself is not observable here.
    for (const readOnly of [false, true]) {
      render(<TerminalKeyBar disabled={false} readOnly={readOnly} onBytes={() => {}} />);
      const bar = readOnly
        ? screen.getByRole("toolbar", { name: "Terminal scrolling" })
        : screen.getByRole("toolbar", { name: "Terminal special keys" });
      // The WHOLE pb-* set, not a substring hunt: a second pb-* utility
      // wins by stylesheet order, not attribute order, and a full inset
      // re-wrapped as `pb-[calc(env(...))]` would slip past a
      // `pb-[env(` regex.
      expect([...bar.classList].filter((c) => c.startsWith("pb-"))).toEqual([
        "pb-[calc(env(safe-area-inset-bottom)/2)]",
      ]);
    }
  });

  it("scroll buttons trail the second row alongside the image button", () => {
    render(
      <TerminalKeyBar
        disabled={false}
        onBytes={() => {}}
        onPickImage={() => {}}
        onScrollTop={() => {}}
        onScrollBottom={() => {}}
      />,
    );
    const slashRow = screen.getByRole("button", { name: "Send slash" }).parentElement;
    expect(screen.getByRole("button", { name: "Scroll to top" }).parentElement).toBe(slashRow);
    expect(screen.getByRole("button", { name: "Scroll to bottom" }).parentElement).toBe(slashRow);
  });
});
