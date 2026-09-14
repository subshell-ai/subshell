import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { type WorkspaceDockContextValue, WorkspaceDockProvider } from "@/components/workspace-dock/context";
import { SubshellTab } from "@/components/workspace-dock/subshell-tab";
import type { WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** A pane row as the workspace detail join delivers it; waiting state off by default. */
function pane(overrides: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "pane-1",
    subshellId: "s-1",
    subshellName: "Alpha",
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
    ...overrides,
  };
}

/**
 * Mounts `<SubshellTab>` inside a dock context holding `panes`, with the fake
 * dockview panel api the tab actually consumes (id, title, title-change
 * subscription). Returns the ids passed to `onRemovePane`.
 */
function renderTab(panes: WorkspacePaneRow[], removed: string[]) {
  const detail = {
    workspace: {
      id: "w-1",
      name: "ws",
      layout: null,
      subshellCount: panes.length,
      draft: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
    panes,
  } satisfies WorkspaceDetail;
  const ctx: WorkspaceDockContextValue = {
    detail,
    searchAddons: new Map(),
    setSearchAddon: () => {},
    onRestart: () => {},
    onRemovePane: (paneId) => removed.push(paneId),
    onCloseSubshell: () => {},
  };
  const props = {
    api: {
      id: "pane-1",
      title: "Alpha",
      onDidTitleChange: () => ({ dispose: () => {} }),
    },
    params: { paneId: "pane-1" },
    tabLocation: "header",
  } as unknown as IDockviewPanelHeaderProps;
  render(
    <WorkspaceDockProvider value={ctx}>
      <SubshellTab {...props} />
    </WorkspaceDockProvider>,
  );
}

afterEach(cleanup);

describe("SubshellTab", () => {
  it("renders the panel title", () => {
    renderTab([pane()], []);
    expect(screen.getByText("Alpha")).toBeDefined();
  });

  it("shows the compact waiting marker for a waiting pane", () => {
    renderTab([pane({ subshellWaitingSince: "2026-08-30T10:00:00.000Z" })], []);
    expect(screen.getByRole("img", { name: "waiting for you" })).toBeDefined();
  });

  it("shows no marker when the pane is not waiting", () => {
    renderTab([pane()], []);
    expect(screen.queryByRole("img", { name: "waiting for you" })).toBeNull();
  });

  it("shows no marker for an exited pane with a stale stamp (isWaiting agrees)", () => {
    renderTab([pane({ subshellWaitingSince: "2026-08-30T10:00:00.000Z", subshellAlive: false })], []);
    expect(screen.queryByRole("img", { name: "waiting for you" })).toBeNull();
  });

  it("shows no marker while the pane is missing from the poll", () => {
    renderTab([], []);
    expect(screen.queryByRole("img", { name: "waiting for you" })).toBeNull();
  });

  it("the × rewires to onRemovePane with the panel id (closeActionOverride semantics)", () => {
    const removed: string[] = [];
    renderTab([pane()], removed);
    fireEvent.click(screen.getByLabelText("Close tab"));
    expect(removed).toEqual(["pane-1"]);
  });
});
