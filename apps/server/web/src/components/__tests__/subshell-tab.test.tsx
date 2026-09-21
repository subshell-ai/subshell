import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { type WorkspaceDockContextValue, WorkspaceDockProvider } from "@/components/workspace-dock/context";
import { SubshellTab } from "@/components/workspace-dock/subshell-tab";
import type { SplitDirection, WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

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

/** What `onSplitPane` recorded, one entry per menu pick. */
type SplitCall = { panelId: string; direction: Exclude<SplitDirection, "within"> };

/**
 * Mounts `<SubshellTab>` inside a dock context holding `panes`, with the fake
 * dockview panel api the tab actually consumes (id, title, title-change
 * subscription). Returns the ids passed to `onRemovePane` and the
 * `(panelId, direction)` pairs passed to `onSplitPane`.
 */
function renderTab(panes: WorkspacePaneRow[], removed: string[], split: SplitCall[] = []) {
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
    onSplitPane: (panelId, direction) => split.push({ panelId, direction }),
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
  return { split, removed };
}

/** Right-clicks the tab and settles once the menu's items are painted. */
async function openMenu() {
  fireEvent.contextMenu(screen.getByText("Alpha"));
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(3));
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

describe("SubshellTab context menu", () => {
  it("right-click opens a menu naming the split the drag gesture never did", async () => {
    renderTab([pane()], []);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Split right" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Split down" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Close pane" })).toBeDefined();
  });

  it("no menu exists before a right-click (nothing else on the tab opens one)", () => {
    renderTab([pane()], []);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("Split right calls onSplitPane with this tab's panel id and 'right'", async () => {
    const split: SplitCall[] = [];
    renderTab([pane()], [], split);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(split).toEqual([{ panelId: "pane-1", direction: "right" }]);
  });

  it("Split down calls onSplitPane with 'below'", async () => {
    const split: SplitCall[] = [];
    renderTab([pane()], [], split);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Split down" }));
    expect(split).toEqual([{ panelId: "pane-1", direction: "below" }]);
  });

  it("Close pane runs the SAME onRemovePane the × calls, exactly once", async () => {
    const removed: string[] = [];
    renderTab([pane()], removed);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close pane" }));
    expect(removed).toEqual(["pane-1"]);
    await waitFor(() => expect(screen.queryAllByRole("menuitem")).toHaveLength(0));
  });

  it("Escape closes the menu without running anything", async () => {
    const split: SplitCall[] = [];
    renderTab([pane()], [], split);
    await openMenu();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Split right" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryAllByRole("menuitem")).toHaveLength(0));
    expect(split).toEqual([]);
  });

  it("a click outside the menu closes it", async () => {
    const split: SplitCall[] = [];
    renderTab([pane()], [], split);
    await openMenu();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryAllByRole("menuitem")).toHaveLength(0));
    expect(split).toEqual([]);
  });
});
