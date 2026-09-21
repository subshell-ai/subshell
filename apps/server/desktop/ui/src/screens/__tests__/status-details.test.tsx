import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
  onOpenChange?: (open: boolean) => void;
}) {
  return render(
    <StatusDetails
      probe={over.probe ?? makeProbe()}
      lastResult={over.lastResult ?? null}
      lastTail={over.lastTail ?? null}
      about={over.about ?? null}
      open={false}
      onOpenChange={over.onOpenChange ?? (() => {})}
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

  it("carries the app's version beside the log, and omits the block without a reading", () => {
    const view = renderDetails({ about: makeAbout() });
    expect(screen.getByText("This app: Subshell Server 0.12.1")).toBeDefined();
    view.unmount();
    renderDetails({ about: null });
    expect(screen.queryByText(/This app:/)).toBeNull();
  });
});
