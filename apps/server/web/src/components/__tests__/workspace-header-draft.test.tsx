import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceHeader } from "@/components/workspace-header";
import { type ConfirmOptions, setConfirmHandler } from "@/lib/confirm";
import type { WorkspaceRow } from "@/types/workspace";

const restore: (() => void)[] = [];

function workspace(draft: boolean): WorkspaceRow {
  return {
    id: "w1",
    name: "Sep 14, 4:45 PM",
    layout: null,
    subshellCount: 2,
    draft,
    createdAt: "2026-09-14T16:45:00.000Z",
    updatedAt: "2026-09-14T16:45:00.000Z",
  };
}

/** Records every request the header makes and answers with `status`. */
function stubFetch(status = 200): { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: String(init?.method ?? "GET") });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { message: "boom" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls };
}

/** Installs a confirm handler, recording what it was asked. */
function stubConfirm(answer: boolean): { asked: ConfirmOptions[] } {
  const asked: ConfirmOptions[] = [];
  const previous = setConfirmHandler(async (options) => {
    asked.push(options);
    return answer;
  });
  restore.push(() => {
    setConfirmHandler(previous);
  });
  return { asked };
}

/** Renders the bar inside a throwaway router (its back control is a Link). */
function renderHeader(draft: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceHeader workspace={workspace(draft)} actions={<button type="button">Add subshell</button>} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("WorkspaceHeader — draft", () => {
  afterEach(() => {
    cleanup();
    for (const undo of restore.splice(0)) undo();
  });

  it("says the workspace is unsaved instead of offering its placeholder name to rename", async () => {
    renderHeader(true);
    expect(await screen.findByText("Unsaved workspace")).toBeTruthy();
    expect(screen.queryByText("Sep 14, 4:45 PM")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
  });

  it("offers Save and Discard ahead of the caller's own actions", async () => {
    renderHeader(true);
    expect(await screen.findByRole("button", { name: "Save workspace…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add subshell" })).toBeTruthy();
  });

  it("promises the subshells keep running, and deletes the draft once confirmed", async () => {
    const { calls } = stubFetch();
    const { asked } = stubConfirm(true);
    renderHeader(true);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/workspaces/w1")).toBe(true);
    });
    expect(asked[0]?.description).toBe("Its subshells keep running.");
    expect(asked[0]?.danger).toBe(true);
  });

  it("deletes nothing when the confirmation is dismissed", async () => {
    const { calls } = stubFetch();
    stubConfirm(false);
    renderHeader(true);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    });
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("says so when the delete fails, instead of navigating away from it", async () => {
    stubFetch(500);
    stubConfirm(true);
    renderHeader(true);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  });

  it("leaves a saved workspace's editable name and bare actions exactly as they were", async () => {
    renderHeader(false);
    expect(await screen.findByText("Sep 14, 4:45 PM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save workspace…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add subshell" })).toBeTruthy();
  });
});
