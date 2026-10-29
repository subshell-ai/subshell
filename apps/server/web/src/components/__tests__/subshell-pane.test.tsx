import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SubshellPane } from "@/components/subshell-pane";
import type { SubshellTerminalHandles } from "@/components/subshell-terminal";
import { resetPaneDiagnosticsPrefForTests, setPaneDiagnosticsIds } from "@/lib/pane-diagnostics-pref";
import type { WorkspacePaneRow } from "@/types/workspace";

/**
 * The workspace touch key bar (the pane half): the ACTIVE pane's terminal
 * gains the same accessory bar the subshell page shows on touch devices.
 * happy-dom reports a fine pointer, so the coarse gate is driven by stubbing
 * matchMedia — the component's only route to "this is a phone".
 */

function paneRow(over: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "p1",
    subshellId: "s1",
    subshellName: "n",
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
    ...over,
  };
}

function stubCoarsePointer(on: boolean) {
  // Only the `(pointer: coarse)` query is answered by the stub — xterm's
  // internals call matchMedia for resolution queries and expect the real
  // (happy-dom) object behind them.
  const real = window.matchMedia.bind(window);
  return spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query === "(pointer: coarse)"
      ? ({
          matches: on,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
        } as unknown as MediaQueryList)
      : real(query),
  );
}

function renderPane(el: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

afterEach(cleanup);

describe("SubshellPane touch key bar", () => {
  it("allows the key bar to scroll while the terminal's touch scroll guard is engaged", () => {
    const spy = stubCoarsePointer(true);
    try {
      renderPane(<SubshellPane pane={paneRow()} active showKeyBar onRestart={() => {}} onRemovePane={() => {}} />);
      const row = screen.getByRole("button", { name: "Send arrow left" }).parentElement as HTMLDivElement;
      row.scrollLeft = 120;
      fireEvent.scroll(row);
      expect(row.scrollLeft).toBe(120);
    } finally {
      cleanup();
      spy.mockRestore();
    }
  });

  it("renders no bar for a fine pointer even when the pane is active", () => {
    const spy = stubCoarsePointer(false);
    renderPane(<SubshellPane pane={paneRow()} active showKeyBar onRestart={() => {}} onRemovePane={() => {}} />);
    expect(screen.queryByRole("toolbar", { name: "Terminal special keys" })).toBeNull();
    spy.mockRestore();
  });

  it("renders no bar for an inactive pane on a touch device", () => {
    const spy = stubCoarsePointer(true);
    renderPane(
      <SubshellPane pane={paneRow()} active={false} showKeyBar={false} onRestart={() => {}} onRemovePane={() => {}} />,
    );
    expect(screen.queryByRole("toolbar", { name: "Terminal special keys" })).toBeNull();
    spy.mockRestore();
  });

  it("the active pane on touch gets the bar; byte keys gray out pre-attach while the scroll jumps stay live", () => {
    const spy = stubCoarsePointer(true);
    renderPane(<SubshellPane pane={paneRow()} active showKeyBar onRestart={() => {}} onRemovePane={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Terminal special keys" });
    // No WS is open (unit env), so `connected` is false: keys inert, scroll live.
    expect(
      (screen.getByRole("button", { name: "Send Ctrl-C" }) as HTMLButtonElement).matches(
        ":disabled, [aria-disabled=true]",
      ),
    ).toBe(true);
    const top = screen.getByRole("button", { name: "Scroll to top" }) as HTMLButtonElement;
    expect(top.matches(":disabled, [aria-disabled=true]")).toBe(false);
    expect(bar).toBeDefined();
    // Tapping must not throw even with no socket behind the handles.
    fireEvent.click(top);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    fireEvent.click(screen.getByRole("button", { name: "Send Enter" }));
    spy.mockRestore();
  });

  it("explains the history buttons once a full-screen app takes the screen this pane cannot send keys to", async () => {
    // The reviewed defect at the pane boundary: the alternate buffer has no
    // local scrollback, so a press is only ever a key, and this unit
    // environment has no socket to carry it. The terminal's buffer switch
    // must reach the bar through `onAltScreenChange` and gray out all four
    // buttons with their reason. Before the switch they stay live, because
    // local scrolling works offline (the sibling test pins that half).
    const spy = stubCoarsePointer(true);
    // A holder object, not a let: the assignment lands in the onReady
    // callback, and a re-read of the property keeps the full declared type.
    const termHolder: { current: SubshellTerminalHandles["term"] | null } = { current: null };
    try {
      renderPane(
        <SubshellPane
          pane={paneRow()}
          active
          showKeyBar
          onRestart={() => {}}
          onRemovePane={() => {}}
          onReady={(handles) => {
            termHolder.current = handles.term;
          }}
        />,
      );
      const top = screen.getByRole("button", { name: "Scroll to top" }) as HTMLButtonElement;
      expect(top.matches(":disabled, [aria-disabled=true]")).toBe(false);
      // A real app enters the alternate buffer the way this pane's program
      // would: DECSET 1049 through the parser. The buffer switch lands as a
      // React state update on the pane, so the write runs inside act.
      await act(async () => {
        await new Promise<void>((done) => {
          if (!termHolder.current) throw new Error("terminal never published handles");
          termHolder.current.write("\x1b[?1049h", done);
        });
      });
      expect(termHolder.current?.buffer.active.type).toBe("alternate");
      for (const name of ["Send Home", "Send Page Up", "Send Page Down", "Send End"]) {
        const button = screen.getByRole("button", { name }) as HTMLButtonElement;
        // The publish is an xterm event, not a React one: poll for it.
        await waitFor(() => expect(button.matches(":disabled, [aria-disabled=true]")).toBe(true));
        expect(button.getAttribute("aria-description")).toMatch(/full-screen app owns this screen/);
        // And the press is inert, not silently swallowed by the handle.
        fireEvent.pointerDown(button, { pointerType: "touch", button: 0, isPrimary: true });
        expect(button.getAttribute("data-pressed")).toBe("false");
      }
    } finally {
      cleanup();
      spy.mockRestore();
    }
  });

  it("an exited pane keeps the log-tail panel — no bar, no terminal", () => {
    const spy = stubCoarsePointer(true);
    renderPane(
      <SubshellPane
        pane={paneRow({ subshellAlive: false })}
        active
        showKeyBar
        onRestart={() => {}}
        onRemovePane={() => {}}
      />,
    );
    expect(screen.queryByRole("toolbar", { name: "Terminal special keys" })).toBeNull();
    spy.mockRestore();
  });
});

describe("SubshellPane node-offline state (spec §5.6 precedence)", () => {
  it("a live subshell on an offline node shows the offline panel, never a terminal", () => {
    renderPane(
      <SubshellPane
        pane={paneRow({ subshellNodeOffline: true })}
        active
        showKeyBar
        onRestart={() => {}}
        onRemovePane={() => {}}
      />,
    );
    expect(screen.getByText(/node offline/i)).toBeDefined();
    expect(screen.queryByRole("toolbar", { name: "Terminal special keys" })).toBeNull();
  });

  it("node-offline outranks the exited panel — the state is unobservable, not dead", () => {
    renderPane(
      <SubshellPane
        pane={paneRow({ subshellNodeOffline: true, subshellAlive: false })}
        active
        showKeyBar
        onRestart={() => {}}
        onRemovePane={() => {}}
      />,
    );
    expect(screen.getByText(/node offline/i)).toBeDefined();
    expect(screen.queryByText(/subshell exited/i)).toBeNull();
  });

  it("node-offline outranks terminated too — a kill on an unreachable node is unverified, and Restart would 409", () => {
    renderPane(
      <SubshellPane
        pane={paneRow({ subshellNodeOffline: true, subshellStatus: "terminated", subshellAlive: false })}
        active
        showKeyBar
        onRestart={() => {}}
        onRemovePane={() => {}}
      />,
    );
    expect(screen.getByText(/node offline/i)).toBeDefined();
    expect(screen.queryByText(/subshell ended/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("the offline panel offers Remove pane but not Restart (restart 409s while the node is away)", () => {
    renderPane(
      <SubshellPane
        pane={paneRow({ subshellNodeOffline: true })}
        active
        showKeyBar
        onRestart={() => {}}
        onRemovePane={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /remove pane/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });
});

/**
 * The Wave C HUD on a docked terminal. The toggle lives in the workspace
 * header's actions menu and the preference is per-device, so the pane has to
 * render the HUD from the same stored set (hooks/use-pane-diagnostics keeps
 * the two components in step) — a header-side "Diagnostics" click must put
 * the HUD over the terminal the header stands above.
 */
describe("SubshellPane diagnostics HUD", () => {
  afterEach(() => {
    localStorage.removeItem("subshell.paneDiagnostics");
    // The module also keeps a page-load memory of a refused write, which is
    // exactly the module state `resetPaneDiagnosticsPrefForTests` exists to
    // clear so this file cannot answer for the next one in the worker.
    resetPaneDiagnosticsPrefForTests();
  });

  it("renders the HUD for a subshell this device turned on", async () => {
    setPaneDiagnosticsIds(["s1"]);
    renderPane(
      <SubshellPane pane={paneRow()} active showKeyBar={false} onRestart={() => {}} onRemovePane={() => {}} />,
    );
    // The HUD's node row is the honest answer for a row nothing seeded:
    // "node you can't see" is its signature line.
    expect(await screen.findByText("node you can't see")).toBeTruthy();
  });

  it("renders no HUD while the device preference is off", async () => {
    renderPane(
      <SubshellPane pane={paneRow()} active showKeyBar={false} onRestart={() => {}} onRemovePane={() => {}} />,
    );
    // Give the terminal its mount (the positive case proves the HUD renders
    // from the same timing), then insist the overlay is absent.
    await Bun.sleep(100);
    expect(screen.queryByText("node you can't see")).toBeNull();
  });
});
