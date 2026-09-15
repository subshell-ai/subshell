import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { InstalledPluginsCard } from "@/components/plugins/installed-plugins-card";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";

/**
 * The Installed list is a headerless table (2026-09-14): ONE grid for every
 * row, each row `display: contents` so its cells are the grid's own children
 * and the four columns share their tracks. The card used to render a bordered
 * flex box per row, and `auto` sizes per container — so the badge, the switch
 * and Uninstall landed at a different x in every row.
 *
 * These cases pin the two halves that a layout change can silently break: the
 * full-width lines (description, the broken notice, a row's own error) still
 * render, and both controls are still reachable by their accessible names.
 */

function row(over: Partial<InstancePluginRow> & { id: string; name: string }): InstancePluginRow {
  return {
    description: "",
    installed: true,
    enabled: true,
    builtIn: false,
    ...over,
  };
}

function renderCard(plugins: InstancePluginRow[], canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InstalledPluginsCard plugins={plugins} canManage={canManage} onUninstall={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("InstalledPluginsCard", () => {
  it("renders every row's cells into ONE grid, so the columns align", () => {
    const { container } = renderCard([
      row({ id: "pi", name: "Pi", version: "1.0.0" }),
      row({ id: "claude-code", name: "Claude Code", version: "2.11.5", binary: "claude" }),
    ]);
    // Exactly one grid: a second one would size its own tracks, which is the
    // ragged staircase this layout replaced.
    const grids = container.querySelectorAll("div.grid");
    expect(grids).toHaveLength(1);
    // And the rows draw nothing themselves — `contents` is what promotes
    // their cells to the grid's own children.
    const rows = (grids[0] as HTMLElement).querySelectorAll(":scope > div.contents");
    expect(rows).toHaveLength(2);
  });

  it("keeps the full-width lines: the description and the broken notice", () => {
    renderCard([row({ id: "pi", name: "Pi", description: "Drives the Pi CLI", broken: "missing entry file" })]);
    const description = screen.getByText("Drives the Pi CLI");
    expect(description.className).toContain("col-span-full");
    const broken = screen.getByText(/missing entry file/);
    expect(broken.className).toContain("col-span-full");
  });

  it("both controls stay reachable by their accessible names", () => {
    renderCard([row({ id: "pi", name: "Pi" })]);
    expect(screen.getByRole("switch", { name: "Pi enabled" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Uninstall Pi" })).toBeDefined();
  });

  it("a reader who manages nothing gets the state as a badge, and no controls", () => {
    renderCard([row({ id: "pi", name: "Pi", enabled: false })], false);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
    expect(screen.getByText("disabled")).toBeDefined();
  });

  it("says so when nothing is installed", () => {
    renderCard([]);
    expect(screen.getByText(/nothing installed yet/i)).toBeDefined();
  });
});
