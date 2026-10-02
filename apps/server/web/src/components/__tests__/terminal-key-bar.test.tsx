import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { KEY_BAR_BUTTONS, TerminalKeyBar } from "@/components/terminal-key-bar";

describe("TerminalKeyBar", () => {
  afterEach(cleanup);

  it("groups all four history controls and keeps page scrolling available without input access", () => {
    const actions: string[] = [];
    render(
      <TerminalKeyBar
        disabled
        readOnly
        onBytes={() => {
          throw new Error("No terminal input");
        }}
        onScrollTop={() => actions.push("top")}
        onScrollPageUp={() => actions.push("up")}
        onScrollPageDown={() => actions.push("down")}
        onScrollBottom={() => actions.push("bottom")}
      />,
    );
    const history = screen.getByRole("group", { name: "Terminal history" });
    expect([...history.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Scroll to top",
      "Scroll page up",
      "Scroll page down",
      "Scroll to bottom",
    ]);
    for (const button of history.querySelectorAll("button")) fireEvent.click(button);
    expect(actions).toEqual(["top", "up", "down", "bottom"]);
  });

  it("opens prompt injection without sending bytes, disables it in copy mode, and hides it for viewers", () => {
    let opened = 0;
    const sent: string[] = [];
    const props = { disabled: false, onBytes: (text: string) => sent.push(text), onInjectPrompt: () => opened++ };
    const { rerender } = render(<TerminalKeyBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Inject prompt" }));
    expect(opened).toBe(1);
    expect(sent).toEqual([]);
    rerender(<TerminalKeyBar {...props} suppressInput />);
    const button = screen.getByRole("button", { name: "Inject prompt" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(opened).toBe(1);
    rerender(<TerminalKeyBar {...props} readOnly />);
    expect(screen.queryByRole("button", { name: "Inject prompt" })).toBeNull();
  });

  it("refreshes without sending input in copy mode, view access, or offline", () => {
    let refreshes = 0;
    const sent: string[] = [];
    const props = { disabled: true, onBytes: (text: string) => sent.push(text), onRefresh: () => refreshes++ };
    const { rerender } = render(<TerminalKeyBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
    rerender(<TerminalKeyBar {...props} suppressInput />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
    rerender(<TerminalKeyBar {...props} readOnly />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
    expect(refreshes).toBe(3);
    expect(sent).toEqual([]);
  });

  it("shows pressed feedback during a hold and briefly after a tap, clearing it on cancellation", async () => {
    const sent: string[] = [];
    render(<TerminalKeyBar disabled={false} onBytes={(text) => sent.push(text)} />);
    const button = screen.getByRole("button", { name: "Send Enter" });
    fireEvent.pointerDown(button);
    expect(button.getAttribute("data-pressed")).toBe("true");
    expect(sent).toEqual([]);
    fireEvent.pointerCancel(button);
    expect(button.getAttribute("data-pressed")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("data-pressed")).toBe("true");
    expect(sent).toEqual(["\r"]);
    await waitFor(() => expect(button.getAttribute("data-pressed")).toBe("false"));
  });

  it("never shows pressed feedback or sends input for a disabled button", () => {
    const sent: string[] = [];
    render(<TerminalKeyBar disabled onBytes={(text) => sent.push(text)} />);
    const button = screen.getByRole("button", { name: "Send Enter" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(button.getAttribute("data-pressed")).toBe("false");
    expect(sent).toEqual([]);
  });

  it("orders Esc, arrows, Enter, newline, photo and scrolls before the remaining controls", () => {
    render(
      <TerminalKeyBar
        disabled={false}
        onBytes={() => {}}
        onPickImage={() => {}}
        onScrollTop={() => {}}
        onScrollBottom={() => {}}
        onPaste={() => {}}
        copyMode={{ on: false, onToggle: () => {} }}
      />,
    );
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Send Escape",
      "Send arrow left",
      "Send arrow up",
      "Send arrow down",
      "Send arrow right",
      "Send Enter",
      "Insert newline",
      "Attach image",
      "Scroll to top",
      "Scroll to bottom",
      "Enable text copying",
      "Paste text",
      "Send Ctrl-C",
      "Send Shift-Tab",
      "Send Tab",
      "Send slash",
    ]);
  });

  it("keeps the mode toggle available in copy mode and offline so input can be restored", () => {
    let toggles = 0;
    const onToggle = () => toggles++;
    const { rerender } = render(<TerminalKeyBar disabled onBytes={() => {}} copyMode={{ on: false, onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable text copying" }));
    expect(toggles).toBe(1);
    rerender(<TerminalKeyBar disabled suppressInput onBytes={() => {}} copyMode={{ on: true, onToggle }} />);
    expect((screen.getByRole("button", { name: "Send Escape" }) as HTMLButtonElement).disabled).toBe(true);
    const toggle = screen.getByRole("button", { name: "Enable text input" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggles).toBe(2);
  });

  it("pastes clipboard text directly without emitting key bytes or opening a text box", async () => {
    const read = spyOn(navigator.clipboard, "readText").mockResolvedValue("first line\nsecond line");
    const pasted: string[] = [];
    const sent: string[] = [];
    try {
      render(
        <TerminalKeyBar disabled={false} onBytes={(text) => sent.push(text)} onPaste={(text) => pasted.push(text)} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
      await waitFor(() => expect(pasted).toEqual(["first line\nsecond line"]));
      expect(sent).toEqual([]);
      expect(screen.queryByRole("textbox")).toBeNull();
    } finally {
      read.mockRestore();
    }
  });

  it("drops pending clipboard input when its terminal bar unmounts", async () => {
    let resolve!: (text: string) => void;
    const read = spyOn(navigator.clipboard, "readText").mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const pasted: string[] = [];
    try {
      const { unmount } = render(
        <TerminalKeyBar disabled={false} onBytes={() => {}} onPaste={(text) => pasted.push(text)} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
      unmount();
      resolve("old terminal input");
      await Promise.resolve();
      expect(pasted).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it("reports denied clipboard access without sending input", async () => {
    const read = spyOn(navigator.clipboard, "readText").mockRejectedValue(new Error("Denied"));
    const error = spyOn(toast, "error").mockImplementation(() => "error");
    const pasted: string[] = [];
    try {
      render(<TerminalKeyBar disabled={false} onBytes={() => {}} onPaste={(text) => pasted.push(text)} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(pasted).toEqual([]);
      expect(screen.queryByRole("textbox")).toBeNull();
    } finally {
      read.mockRestore();
      error.mockRestore();
    }
  });

  it("disables paste offline and in copy mode, and hides it for view access", () => {
    const { rerender } = render(<TerminalKeyBar disabled onBytes={() => {}} onPaste={() => {}} />);
    expect((screen.getByRole("button", { name: "Paste text" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<TerminalKeyBar disabled={false} suppressInput onBytes={() => {}} onPaste={() => {}} />);
    expect((screen.getByRole("button", { name: "Paste text" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<TerminalKeyBar disabled={false} readOnly onBytes={() => {}} onPaste={() => {}} />);
    expect(screen.queryByRole("button", { name: "Paste text" })).toBeNull();
  });

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
      fireEvent(btn, down);
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

  it("keeps keys and the image button on one horizontally scrollable row", () => {
    // Controls keep their touch targets and scroll horizontally rather than wrapping.
    render(<TerminalKeyBar disabled={false} onBytes={() => {}} onPickImage={() => {}} />);
    const escRow = screen.getByRole("button", { name: "Send Escape" }).parentElement;
    const enterRow = screen.getByRole("button", { name: "Send Enter" }).parentElement;
    const slashRow = screen.getByRole("button", { name: "Send slash" }).parentElement;
    const imgRow = screen.getByRole("button", { name: "Attach image" }).parentElement;
    expect(enterRow).toBe(escRow); // controls stay together
    expect(slashRow).toBe(escRow);
    expect(escRow?.classList.contains("overflow-x-auto")).toBe(true);
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

  it("copy mode keeps the row and scroll position while disabling all input controls", () => {
    const sent: string[] = [];
    const props = {
      disabled: false,
      onBytes: (text: string) => sent.push(text),
      onPickImage: () => sent.push("image"),
      onPaste: () => sent.push("paste"),
      onScrollTop: () => sent.push("top"),
      onScrollBottom: () => sent.push("bottom"),
    };
    const { rerender } = render(<TerminalKeyBar {...props} />);
    const row = screen.getByRole("button", { name: "Send Escape" }).parentElement as HTMLDivElement;
    const controls = [...row.children];
    row.scrollLeft = 120;
    rerender(<TerminalKeyBar {...props} suppressInput />);
    expect(screen.getByRole("toolbar", { name: "Terminal special keys" })).toBeDefined();
    expect([...row.children]).toEqual(controls);
    expect(row.scrollLeft).toBe(120);
    for (const name of [...KEY_BAR_BUTTONS.map((b) => b.aria), "Attach image", "Paste text"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    expect(sent).toEqual(["top", "bottom"]);
    rerender(<TerminalKeyBar {...props} />);
    expect(row.scrollLeft).toBe(120);
    expect((screen.getByRole("button", { name: "Send Escape" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("suppressInput left off keeps the full bar", () => {
    render(<TerminalKeyBar disabled={false} suppressInput={false} onBytes={() => {}} />);
    expect(screen.getByRole("toolbar", { name: "Terminal special keys" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Send Escape" })).toBeDefined();
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

  it("scroll buttons share the row with the image button", () => {
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
    const history = screen.getByRole("group", { name: "Terminal history" });
    expect(screen.getByRole("button", { name: "Scroll to top" }).parentElement).toBe(history);
    expect(screen.getByRole("button", { name: "Scroll to bottom" }).parentElement).toBe(history);
    expect(history.parentElement).toBe(slashRow);
  });
});
