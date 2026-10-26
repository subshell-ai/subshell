import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SshPresetLibrary } from "@/components/presets/ssh-preset-library";
import type { SshPreset } from "@/types/preset";

/**
 * The SSH table's Enabled column, through the real `useTogglePresetEnabled`
 * hook against a mocked fetch: the switch is the owner/edit grant's control,
 * PATCHes its own row with the exact body, and a successful toggle refetches
 * the SSH list (the `["presets"]` prefix covers `["presets", "ssh"]`). A
 * parked preset stays listed, dimmed: the management view shows everything.
 */

function sshPreset(over: Partial<SshPreset> = {}): SshPreset {
  return {
    kind: "ssh",
    id: "p1",
    name: "Build box",
    description: null,
    nodeId: "desk",
    destination: "user@build:22",
    alias: "build",
    authentication: "local-key",
    keyHome: null,
    fingerprints: [],
    forwards: [],
    enabled: 1,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
    ...over,
  };
}

/** Mocks fetch and records every call; the PATCH answers with the updated row. */
function mockFetch(rows: SshPreset[]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (init?.method === "PATCH") return Promise.resolve(Response.json({ ...rows[0], enabled: 0 }));
    if (url.pathname === "/api/presets") return Promise.resolve(Response.json(rows));
    if (url.pathname === "/api/nodes") return Promise.resolve(Response.json({ nodes: [] }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Mounts the library; the rows it shows come from the mocked fetch, not props. */
async function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <SshPresetLibrary creating={false} onCreate={() => {}} onCreatedClose={() => {}} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

const sshList = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === "GET" && c.url === "/api/presets?kind=ssh").length;

it("shows a disabled SSH preset's switch as off and dims the row", async () => {
  const mock = mockFetch([sshPreset({ enabled: 0 })]);
  await renderLibrary();
  const switchEl = await screen.findByRole("switch", { name: "Build box enabled" });
  expect(switchEl.getAttribute("aria-checked")).toBe("false");
  expect((switchEl.closest("tr") as HTMLElement).className).toContain("opacity-70");
  mock.restore();
});

it("flipping an enabled SSH preset off pins the PATCH route and body", async () => {
  const mock = mockFetch([sshPreset({ enabled: 1 })]);
  await renderLibrary();
  fireEvent.click(await screen.findByRole("switch", { name: "Build box enabled" }));
  await waitFor(() => {
    const patch = mock.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch?.url).toBe("/api/presets/p1");
    expect(patch?.body).toBe(JSON.stringify({ enabled: false }));
  });
  mock.restore();
});

it("flipping a disabled SSH preset on PATCHes enabled true", async () => {
  const mock = mockFetch([sshPreset({ enabled: 0 })]);
  await renderLibrary();
  fireEvent.click(await screen.findByRole("switch", { name: "Build box enabled" }));
  await waitFor(() => {
    expect(mock.calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ enabled: true }))).toBe(true);
  });
  mock.restore();
});

it("refetches the SSH list after a successful toggle", async () => {
  const mock = mockFetch([sshPreset({ enabled: 1 })]);
  await renderLibrary();
  fireEvent.click(await screen.findByRole("switch", { name: "Build box enabled" }));
  await waitFor(() => expect(mock.calls.some((c) => c.method === "PATCH")).toBe(true));
  // ORDER, not a count: the GETs must bracket the PATCH, one answering the
  // initial load before it and at least one landing after the invalidation.
  // `>= 2` alone would pass on a mutation that never refetched. waitFor polls,
  // so the async refetch is awaited rather than slept on.
  await waitFor(() => {
    const patchIndex = mock.calls.findIndex((c) => c.method === "PATCH");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(sshList(mock.calls.slice(0, patchIndex)) >= 1).toBe(true);
    expect(sshList(mock.calls.slice(patchIndex + 1)) >= 1).toBe(true);
  });
  mock.restore();
});

it("gives a view-only SSH viewer a plain yes instead of a switch", async () => {
  const mock = mockFetch([sshPreset({ access: "view", enabled: 1 })]);
  await renderLibrary();
  await screen.findByText("Build box");
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.getByText("Yes")).toBeTruthy();
  mock.restore();
});
