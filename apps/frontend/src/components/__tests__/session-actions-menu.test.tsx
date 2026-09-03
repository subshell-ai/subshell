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
import { SessionActionsMenu } from "@/components/session-actions-menu";
import type { SessionView } from "@/types/session";

/** A full SessionView with overridable fields — mirrors the session-list fixture. */
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "id-1",
    profileId: "profile-1",
    harnessId: "claude",
    nodeOffline: false,
    name: "session",
    nameLocked: false,
    terminalReplayLines: null,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-08-30T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  };
}

/**
 * The menu needs a router (its profile-edit item calls `useNavigate`), so it
 * renders as an index route of a minimal memory router — the same context
 * the app itself installs.
 */
async function renderMenu(session: SessionView) {
  // retry: 0 so the profiles query settles on the first canned response.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SessionActionsMenu session={session} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Records every request's method/url/body; answers the profiles query with
 *  [] and mutations with `{ ok: true }`. */
function mockFetch() {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", url: url.pathname, body: init?.body as string | undefined });
    return Promise.resolve(new Response(JSON.stringify(url.pathname.startsWith("/api/profiles") ? [] : { ok: true })));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Opens the menu the keyboard way (Base UI triggers open on pointerdown,
 *  which happy-dom cannot emulate; ArrowDown is equivalent) and waits for
 *  the items to paint. */
async function openMenu(sessionName: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${sessionName}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

describe("SessionActionsMenu — notification bell", () => {
  afterEach(cleanup);

  it("offers 'Notify when done' on a muted session and PATCHes notify:true", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSession({ id: "abc", notify: false }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Notify when done" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "PATCH", url: "/api/sessions/abc/notify", body: '{"notify":true}' }),
      );
      expect(screen.queryByRole("menuitem", { name: "Mute notifications" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("offers 'Mute notifications' on a notified session and PATCHes notify:false", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSession({ id: "abc", notify: true }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Mute notifications" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "PATCH", url: "/api/sessions/abc/notify", body: '{"notify":false}' }),
      );
    } finally {
      restore();
    }
  });
});

describe("SessionActionsMenu — access gating (spec §4.1)", () => {
  afterEach(cleanup);

  it("renders no actions menu at all for a view grantee", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSession({ access: "view" }));
      expect(screen.queryByRole("button", { name: "Actions for session" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("an edit grantee can manage the session but not the bell, sharing, or deletion", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSession({ access: "edit", alive: true }));
      await openMenu("session");
      expect(screen.getByRole("menuitem", { name: "Terminate" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Add note" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Edit title" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Notify when done" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Share…" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Delete session" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("Clone… appears for edit grantees and opens the clone dialog", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSession({ access: "edit" }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Clone…" }));
      expect(await screen.findByLabelText("Clone name")).toBeDefined();
      expect(screen.getByRole("button", { name: "Launch clone" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("Edit title opens the rename dialog and a save PATCHes the trimmed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSession({ id: "abc" }));
      await openMenu("session");
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit title" }));
      const input = await screen.findByRole("textbox", { name: "New session title" });
      fireEvent.change(input, { target: { value: " Renamed " } });
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "PATCH",
          url: "/api/sessions/abc/name",
          body: JSON.stringify({ name: "Renamed" }),
        }),
      );
    } finally {
      restore();
    }
  });
});
