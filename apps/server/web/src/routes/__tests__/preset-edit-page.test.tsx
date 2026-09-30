import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Route } from "@/routes/presets_.$id";
import type { PresetRow } from "@/types/preset";

/**
 * The preset EDIT page's save gate (live-test finding, 2026-09-30): blanking
 * the Name must disable Save, not send a name the server schema refuses.
 * The same guard sits on the create dialog; both are pinned here and there.
 */

const ROW: PresetRow = {
  id: "p1",
  harnessId: "claude-code",
  name: "Fast",
  description: null,
  envJson: null,
  flagsJson: null,
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 0,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
  crossCommEnabled: 0,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

function mockFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/presets" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([ROW])));
    }
    if (url.pathname === "/api/plugins") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            plugins: [{ id: "claude-code", name: "Claude Code", description: "", installed: true, enabled: true }],
          }),
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const editRoute = Route.update({
    id: "/presets_/$id",
    path: "/presets/$id",
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([editRoute]),
    history: createMemoryHistory({ initialEntries: ["/presets/p1"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("preset edit page save gate", () => {
  it("disables Save while the name is blank and re-enables it when refilled", async () => {
    const restore = mockFetch();
    try {
      const view = renderEditor();
      const nameInput = (await screen.findByLabelText("Name")) as HTMLInputElement;
      const save = () => view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save().disabled).toBe(false);
      fireEvent.change(nameInput, { target: { value: "   " } });
      expect(save().disabled).toBe(true);
      fireEvent.change(nameInput, { target: { value: "Fast" } });
      expect(save().disabled).toBe(false);
    } finally {
      restore();
    }
  });
});
