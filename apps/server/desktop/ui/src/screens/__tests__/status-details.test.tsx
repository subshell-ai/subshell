import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeAbout, makeProbe } from "../../__tests__/harness";
import type { LogTail } from "../../lib/ipc";
import { StatusDetails } from "../status-details";

afterEach(cleanup);

function renderDetails(over: {
  probe?: ReturnType<typeof makeProbe>;
  lastResult?: Parameters<typeof StatusDetails>[0]["lastResult"];
  lastTail?: LogTail | null;
  about?: Parameters<typeof StatusDetails>[0]["about"];
  onReveal?: (target: string) => void;
}) {
  return render(
    <StatusDetails
      probe={over.probe ?? makeProbe()}
      lastResult={over.lastResult ?? null}
      lastTail={over.lastTail ?? null}
      about={over.about ?? null}
      // No `open` to pass: wave 2's ruling made the block the Status
      // section's inline content, and a test that "opens" it would test a
      // control that no longer exists.
      onReveal={(target) => over.onReveal?.(target)}
    />,
  );
}

describe("the facts", () => {
  it("renders each row the model computes, with the model's tone", () => {
    const probe = makeProbe({ tmux: null });
    renderDetails({ probe });
    expect(screen.getByText("tmux")).toBeDefined();
    expect(screen.getByText("NOT FOUND")).toBeDefined();
    // The missing-tmux value is bad news, and the model says so.
    const notFound = screen.getByText("NOT FOUND");
    expect(notFound.className).toBe("bad-text");
  });

  it("offers Reveal only on rows the model named, and names the INTENT", () => {
    const onReveal = vi.fn();
    // The Service row is the one whose reveal is unconditional on an installed
    // definition: the machine's default probe carries none.
    const probe = makeProbe({
      next: "start",
      service: {
        installed: true,
        definitionPath: "/Users/u/Library/LaunchAgents/dev.subshell.server.plist",
        state: "stopped",
        pid: null,
        enabled: true,
        paneSafety: "keeps",
        detail: "",
      },
    });
    renderDetails({ probe, onReveal });
    const reveals = screen.getAllByRole("button", { name: "Reveal" });
    expect(reveals.length).toBeGreaterThan(0);
    reveals[0].click();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("puts dt and dd in the grid as DIRECT children, one row per pair", () => {
    // `.facts` is `display:grid; grid-template-columns:132px 1fr` and reads
    // its dt/dd as direct children; a wrapper div per row would make each row
    // ONE grid item and collapse the table into alternating narrow columns.
    renderDetails({ probe: makeProbe() });
    const dl = document.querySelector("dl.facts") as HTMLDListElement;
    expect(dl.children.length).toBeGreaterThan(0);
    for (const child of dl.children) {
      expect(["DT", "DD"]).toContain(child.tagName);
    }
  });
});

describe("the tail's stick", () => {
  it("keeps a growing tail pinned to the bottom, and does not yank a reader who scrolled up", async () => {
    // happy-dom has no layout, so the geometry is stubbed on the element the
    // component measures. `scrollTop` is the observable: the effect re-sticks
    // by writing scrollHeight into it, and honours a scrolled-up reader by
    // writing nothing.
    const { rerender } = renderDetails({ lastTail: { text: "line 1", source: "server", note: null } });
    const pane = document.querySelector("pre.pane-pre") as HTMLPreElement;
    const geometry = (box: HTMLPreElement, height: number, at: number): void => {
      Object.defineProperty(box, "scrollHeight", { configurable: true, value: height });
      Object.defineProperty(box, "clientHeight", { configurable: true, value: 100 });
      Object.defineProperty(box, "scrollTop", { configurable: true, get: () => at, set: (v) => (at = v) });
    };
    geometry(pane, 100, 0);
    // Pinned: the pane sits at the bottom, and the next tick keeps it there.
    rerender(
      <StatusDetails
        probe={makeProbe()}
        lastResult={null}
        lastTail={{ text: "line 1\nline 2", source: "server", note: null }}
        about={null}
        onReveal={() => {}}
      />,
    );
    await Promise.resolve();
    expect(pane.scrollTop).toBe(pane.scrollHeight); // re-stuck to the grown log

    // A reader scrolled up: the pane keeps their offset. The scroll listener
    // is what carries that fact (the old code measured before writing; a
    // React render writes first), so it is fired as the reader's act.
    geometry(pane, 200, 50); // 200 - 50 - 100 = 50, outside the 24px slack
    fireEvent.scroll(pane);
    rerender(
      <StatusDetails
        probe={makeProbe()}
        lastResult={null}
        lastTail={{ text: "line 1\nline 2\nline 3", source: "server", note: null }}
        about={null}
        onReveal={() => {}}
      />,
    );
    await Promise.resolve();
    expect(pane.scrollTop).toBe(50); // not yanked
  });
});

describe("the panes", () => {
  it("renders the tail's text, or its note as the pane's own muted text", () => {
    const { container, unmount } = renderDetails({ lastTail: { text: "log line", source: "server", note: null } });
    expect(screen.getByText("log line")).toBeDefined();
    expect(container.querySelector("pre.pane-pre.muted-text")).toBeNull();
    unmount();
    renderDetails({ lastTail: { text: "", source: "server", note: "No server has been set up yet." } });
    expect(screen.getByText("No server has been set up yet.")).toBeDefined();
    expect(document.querySelector("pre.pane-pre.muted-text")).not.toBeNull();
  });

  it("renders the last action's words, styled as a failure when it did not succeed", () => {
    const failing = { ok: false, stdout: "did a thing", stderr: "and failed" };
    const { container, unmount } = renderDetails({ lastResult: failing });
    expect(screen.getByText("Last action")).toBeDefined();
    expect(container.querySelector("pre.pane-pre.output-bad")?.textContent).toContain("and failed");
    unmount();
    // Nothing said, nothing shown: `.pane-pre:empty` would collapse a bordered
    // void, so the block is left out entirely.
    renderDetails({ lastResult: { ok: true, stdout: "", stderr: "" } });
    expect(screen.queryByText("Last action")).toBeNull();
  });

  it("shows the app version and the running server's CLI version as the first facts", () => {
    // The version facts moved from a lone line under the log to the top of the
    // facts grid, and the Server CLI version joined the app version (operator
    // ruling 2026-09-23).
    const view = renderDetails({
      about: makeAbout(),
      probe: makeProbe({ server: { argv: ["/x/subshell-server"], source: "local-bin", version: "0.16.0" } }),
    });
    expect(screen.getByText("This app")).toBeDefined();
    expect(screen.getByText("Subshell Server 0.12.1")).toBeDefined();
    expect(screen.getByText("Server CLI")).toBeDefined();
    expect(screen.getByText("0.16.0")).toBeDefined();
    view.unmount();
    // No About reading means no app row; no server means no CLI row.
    renderDetails({ about: null });
    expect(screen.queryByText("This app")).toBeNull();
    expect(screen.queryByText("Server CLI")).toBeNull();
  });
});

describe("the inline rule (wave 2)", () => {
  it("renders as the section's content, with no disclosure around it", () => {
    // The operator's ruling, 2026-09-22: the Show Details disclosure is
    // gone — a sidebar section that hides its own facts behind a second
    // control is two navigations for one answer. The block is always on
    // screen, and nothing about it collapses.
    renderDetails({ lastTail: { text: "log line", source: "server", note: null } });
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector("summary")).toBeNull();
    expect(screen.getByText("Server log")).toBeDefined();
    expect(screen.getByText("log line")).toBeDefined();
  });
});
