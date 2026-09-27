import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceTab } from "@/components/workspace-tabs";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspacePaneRow } from "@/types/workspace";

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
 * Renders one tab with a waiting flag precomputed (the parent owns
 * `isPaneWaiting`). The tab's dot reads the shared list cache
 * (`useSubshellRow`), so the harness provides a QueryClient seeded with one
 * quiet row per pane — unless `rows` overrides it, and `[]` is the world
 * where the list has not answered and the tab must draw no dot.
 */
function renderTab(opts: { waiting: boolean; removed?: string[]; selected?: string[]; rows?: unknown[] }) {
  const removed = opts.removed ?? [];
  const selected = opts.selected ?? [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(
    SUBSHELLS_QUERY_KEY,
    opts.rows ?? [{ id: "s-1", name: "Alpha", status: "running", alive: true, activity: "idle" }],
  );
  render(
    <QueryClientProvider client={client}>
      <WorkspaceTab
        pane={pane()}
        active
        waiting={opts.waiting}
        onSelect={() => selected.push("pane-1")}
        onRemove={() => removed.push("pane-1")}
      />
    </QueryClientProvider>,
  );
  return { removed, selected };
}

afterEach(cleanup);

describe("WorkspaceTab (narrow tab strip)", () => {
  it("renders the subshell name", () => {
    renderTab({ waiting: false });
    expect(screen.getByText("Alpha")).toBeDefined();
  });

  it("carries the rail's dot with the raw status/alive pair for a cached row", () => {
    renderTab({ waiting: false });
    const dot = document.querySelector("[data-status]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-status")).toBe("running");
    expect(dot?.getAttribute("data-alive")).toBe("true");
  });

  it("draws NO dot before the list cache answers", () => {
    renderTab({ waiting: false, rows: [] });
    expect(document.querySelector("[data-status]")).toBeNull();
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
