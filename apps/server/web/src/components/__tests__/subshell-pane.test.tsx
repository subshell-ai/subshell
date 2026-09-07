import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SubshellPane } from "@/components/subshell-pane";
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
    expect((screen.getByRole("button", { name: "Send Ctrl-C" }) as HTMLButtonElement).disabled).toBe(true);
    const top = screen.getByRole("button", { name: "Scroll to top" }) as HTMLButtonElement;
    expect(top.disabled).toBe(false);
    expect(bar).toBeDefined();
    // Tapping must not throw even with no socket behind the handles.
    fireEvent.click(top);
    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    fireEvent.click(screen.getByRole("button", { name: "Send Enter" }));
    spy.mockRestore();
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
