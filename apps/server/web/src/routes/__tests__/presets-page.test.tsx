import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { Route } from "@/routes/presets";
import type { PresetRow } from "@/types/preset";

/**
 * The /presets page (spec 2026-09-13 §5): rows grouped under their agent's
 * header (icon + name, fallback harnessId for a row the catalog cannot name),
 * EVERY row deletable — the unremovable seeded Default is gone with the
 * seeding itself — and one frozen copy set: header, button, empty state,
 * row menu, confirm.
 */

function presetRow(p: { id: string; harnessId: string; name: string }): PresetRow {
  return {
    ...p,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

const ROWS: PresetRow[] = [
  presetRow({ id: "p1", harnessId: "claude-code", name: "Fast" }),
  presetRow({ id: "p2", harnessId: "pi", name: "Solo" }),
  presetRow({ id: "p3", harnessId: "claude-code", name: "Deep" }),
  presetRow({ id: "p4", harnessId: "acme", name: "Orphan" }), // not in the catalog
];

function mockFetch(opts: { presets?: PresetRow[] } = {}) {
  const presets = opts.presets ?? ROWS;
  const calls: { method: string; url: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname });
    if (url.pathname === "/api/presets") return Promise.resolve(new Response(JSON.stringify(presets)));
    if (url.pathname === "/api/plugins") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            plugins: [
              {
                id: "claude-code",
                name: "Claude Code",
                icon: "🤖",
                binary: "claude",
                description: "",
                installed: true,
                enabled: true,
                builtIn: true,
              },
              { id: "pi", name: "Pi", description: "", installed: true, enabled: true, builtIn: true },
            ],
          }),
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <ConfirmProvider>
        <Outlet />
      </ConfirmProvider>
    ),
  });
  const presetsRoute = Route.update({ id: "/presets", path: "/presets", getParentRoute: () => rootRoute } as never);
  const editRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/presets/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([presetsRoute, editRoute]),
    history: createMemoryHistory({ initialEntries: ["/presets"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("/presets page", () => {
  it("groups rows under their agent's header — name from the catalog, id as the fallback — in catalog order", async () => {
    const { restore } = mockFetch();
    try {
      const { container } = renderPage();
      expect(await screen.findByText("Fast")).toBeDefined();
      // Group headers are real HEADINGS, not styled spans: e2e names them by
      // role because a presetless row's command preview renders the bare
      // harness id, which plain text matching would collide with.
      expect(screen.getByRole("heading", { name: "Claude Code" })).toBeDefined();
      expect(screen.getByRole("heading", { name: "Pi" })).toBeDefined();
      // A harness the catalog cannot name still leads its own group, keyed by
      // id — twice on screen, honestly: the header AND the launch-command
      // preview, whose binary falls back to the id too.
      expect(screen.getAllByText("acme").length).toBe(2);
      const text = container.textContent ?? "";
      // Catalog order first (claude, pi), unknown harnesses last; within the
      // Claude group both rows sit together, above Pi's.
      expect(text.indexOf("Deep")).toBeLessThan(text.indexOf("Solo"));
      expect(text.indexOf("Solo")).toBeLessThan(text.indexOf("Orphan"));
      // No harness badge on the rows — the header says it once.
      expect(screen.queryByText("claude-code")).toBeNull();
    } finally {
      restore();
    }
  });

  it("every row offers Delete — nothing is unremovable any more", async () => {
    const { restore } = mockFetch();
    try {
      renderPage();
      await screen.findByText("Fast");
      for (const name of ["Fast", "Deep", "Solo", "Orphan"]) {
        const trigger = screen.getByRole("button", { name: `Actions for ${name}` });
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
        await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
        expect(screen.getByRole("menuitem", { name: "Delete preset" })).toBeDefined();
        expect(screen.getByRole("menuitem", { name: "Edit" })).toBeDefined();
        fireEvent.keyDown(document.body, { key: "Escape" });
        await waitFor(() => expect(screen.queryAllByRole("menuitem").length).toBe(0));
      }
    } finally {
      restore();
    }
  });

  it("delete confirms with the frozen copy and sends DELETE", async () => {
    const { calls, restore } = mockFetch();
    try {
      renderPage();
      await screen.findByText("Fast");
      fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Fast" }), { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete preset" }));
      const dialog = await screen.findByRole("dialog", { name: "Delete this preset?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", url: "/api/presets/p1" }));
    } finally {
      restore();
    }
  });

  it("the header, the button, and the unlocked create dialog", async () => {
    const { restore } = mockFetch();
    try {
      renderPage();
      expect(await screen.findByRole("heading", { name: "Presets" })).toBeDefined();
      expect(screen.getByText("Saved launch settings, per agent")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "New preset" }));
      expect(await screen.findByRole("dialog", { name: "Create preset" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("empty account: the frozen empty state, naming the option of launching without one", async () => {
    const { restore } = mockFetch({ presets: [] });
    try {
      renderPage();
      expect(await screen.findByText("No presets yet")).toBeDefined();
      expect(
        screen.getByText(
          "A preset is saved launch settings for one agent: env vars, flags, and whether its subshells restart themselves. You can always start a subshell without one.",
        ),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "Create your first preset" })).toBeDefined();
    } finally {
      restore();
    }
  });
});
