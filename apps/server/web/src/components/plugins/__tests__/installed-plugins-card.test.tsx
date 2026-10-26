import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { InstalledPluginsCard } from "@/components/plugins/installed-plugins-card";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";

/**
 * Keep management controls accessible to managers and absent for readers.
 * Grid alignment belongs in browser review; Happy DOM cannot measure it.
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
});
