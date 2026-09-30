import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mockFetch(nodes: unknown[] = []) {
  const puts: { url: string; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/nodes" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ nodes })));
    }
    if (url.pathname === "/api/presets/p1" && method === "PUT") {
      puts.push({ url: url.pathname, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify(ROW)));
    }
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
  return { puts, restore: () => (globalThis.fetch = original) };
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

describe("preset edit page switch click-through", () => {
  it("a real toggle-click reaches the PUT: the body carries crossCommEnabled", async () => {
    // The gap this pins: earlier tests only read the switch's DISABLED state,
    // never clicked it - so a click that painted but never flipped the form
    // value saved the row back to OFF (operator live test, 2026-09-30).
    const desk = {
      id: "a1",
      name: "desk",
      kind: "agent",
      status: "online",
      os: null,
      arch: null,
      maintenance: false,
      inventoryStale: false,
      canLaunch: true,
      harnesses: [{ harnessId: "claude-code", name: "Claude Code", installed: true }],
    };
    const m = mockFetch([desk]);
    try {
      renderEditor();
      const view = await screen.findByLabelText("Name");
      void view;
      const dialog = document.body;
      // Requirements first (the switch refuses to arm while gaps exist).
      fireEvent.change(dialog.querySelector("#preset-launch-dir") as HTMLInputElement, {
        target: { value: "/srv/app" },
      });
      fireEvent.click(dialog.querySelector("#preset-launch-node") as HTMLElement);
      const option = await screen.findByRole("option", { name: /desk/ });
      fireEvent.pointerDown(option);
      fireEvent.pointerUp(option);
      fireEvent.click(option);
      const toggle = () => dialog.querySelector("#preset-cross-comm") as HTMLButtonElement;
      await waitFor(() => expect(toggle().disabled).toBe(false));
      fireEvent.click(toggle());
      expect(
        toggle().getAttribute("aria-checked") ?? (toggle() as unknown as { checked: boolean }).checked,
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(m.puts).toHaveLength(1));
      expect(m.puts[0].body).toMatchObject({
        crossCommEnabled: true,
        nodeId: "a1",
        workingDir: "/srv/app",
      });
    } finally {
      m.restore();
    }
  });
});

describe("preset edit page save gate", () => {
  it("disables Save while the name is blank and re-enables it when refilled", async () => {
    const { restore } = mockFetch();
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
