import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceTab } from "@/components/workspace-tabs";
import type { WorkspacePaneRow } from "@/types/workspace";

/** A pane row as the workspace detail join delivers it; waiting state off by default. */
function pane(overrides: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "pane-1",
    sessionId: "s-1",
    sessionName: "Alpha",
    sessionStatus: "running",
    sessionAlive: true,
    sessionExitCode: null,
    sessionWaitingSince: null,
    workingDir: "/tmp",
    ...overrides,
  };
}

/** Renders one tab with a waiting flag precomputed (the parent owns `isPaneWaiting`). */
function renderTab(opts: { waiting: boolean; removed?: string[]; selected?: string[] }) {
  const removed = opts.removed ?? [];
  const selected = opts.selected ?? [];
  render(
    <WorkspaceTab
      pane={pane()}
      active
      waiting={opts.waiting}
      onSelect={() => selected.push("pane-1")}
      onRemove={() => removed.push("pane-1")}
    />,
  );
  return { removed, selected };
}

afterEach(cleanup);

describe("WorkspaceTab (narrow tab strip)", () => {
  it("renders the session name", () => {
    renderTab({ waiting: false });
    expect(screen.getByText("Alpha")).toBeDefined();
  });

  it("shows the compact waiting marker when the pane is waiting", () => {
    renderTab({ waiting: true });
    expect(screen.getByRole("img", { name: "waiting for you" })).toBeDefined();
  });

  it("shows no marker when the pane is not waiting", () => {
    renderTab({ waiting: false });
    expect(screen.queryByRole("img", { name: "waiting for you" })).toBeNull();
  });

  it("the marker is inside the select button, not the remove button", () => {
    renderTab({ waiting: true });
    const marker = screen.getByRole("img", { name: "waiting for you" });
    const button = marker.closest("button");
    expect(button?.getAttribute("aria-current")).toBe("true");
  });

  it("selecting fires onSelect", () => {
    const { selected } = renderTab({ waiting: true });
    fireEvent.click(screen.getByText("Alpha"));
    expect(selected).toEqual(["pane-1"]);
  });

  it("the × fires onRemove", () => {
    const { removed } = renderTab({ waiting: false });
    fireEvent.click(screen.getByLabelText("Remove Alpha from workspace"));
    expect(removed).toEqual(["pane-1"]);
  });
});
