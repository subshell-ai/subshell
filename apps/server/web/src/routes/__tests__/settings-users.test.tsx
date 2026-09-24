import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/settings_.users";
import { setFetchRouter } from "@/test-setup";

/**
 * The `/settings/users` page's admin gate and the service-account row.
 *
 * The gate changed meaning when the roster became an admin page (spec
 * 2026-09-14): a member used to see a read-only table here and now sees the
 * guidance sentence every other admin page gives them. So the assertion that
 * matters is not "no controls" but "no ROSTER, and no request for one" — the
 * same rule Status follows, where firing a read a member is not meant to make
 * is the defect.
 *
 * For an admin, the two things that regress silently: the header's own
 * "Add user" affordance (e2e pins that accessible name) and the `system`
 * account, whose controls the server refuses by design.
 */
const SYSTEM_ID = "sys-1";
const MEMBER_ID = "mem-1";
/** The signed-in admin's own id — what the better-auth session below answers. */
const VIEWER_ID = "me";
const DISABLED_ID = "dis-1";

function roster() {
  return {
    viewerIsAdmin: true,
    users: [
      {
        id: SYSTEM_ID,
        name: "System",
        email: "system@subshell.local",
        role: "user",
        createdAt: null,
        manageable: false,
      },
      { id: MEMBER_ID, name: "Dana", email: "dana@example.com", role: "user", createdAt: null, manageable: true },
      {
        id: VIEWER_ID,
        name: "You",
        email: "you@example.com",
        role: "admin",
        createdAt: null,
        manageable: true,
      },
      {
        id: DISABLED_ID,
        name: "Cleo",
        email: "cleo@example.com",
        role: "admin",
        createdAt: null,
        manageable: true,
        disabled: true,
      },
    ],
  };
}

/**
 * Answers every request the page makes, through `setFetchRouter` rather than
 * by swapping `globalThis.fetch`: the better-auth client behind
 * `useCurrentUser` binds fetch at MODULE EVALUATION, so a later swap is
 * invisible to it and the session request goes to the real network
 * (ECONNREFUSED noise on port 80). See `src/test-setup.ts`.
 */
function mockFetch(viewerIsAdmin: boolean) {
  const calls: string[] = [];
  setFetchRouter((input: RequestInfo | URL) => {
    const url = new URL(
      String(typeof input === "string" || input instanceof URL ? input : input.url),
      "http://localhost",
    );
    calls.push(url.pathname);
    // The gate reads the server's own flag, not the roster envelope's.
    if (url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ viewerIsAdmin, serverVersion: "1.5.0" })));
    }
    if (url.pathname === "/api/users") return Promise.resolve(new Response(JSON.stringify(roster())));
    // The table also asks better-auth who the viewer is.
    return Promise.resolve(new Response(JSON.stringify({ user: { id: VIEWER_ID } })));
  });
  return { calls, restore: () => setFetchRouter(null) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // Re-parented onto a test root, as in server-status.test.tsx.
  const usersRoute = Route.update({
    id: "/settings_/users",
    path: "/settings/users",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([usersRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/users"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("/settings/users page", () => {
  it("offers an admin the roster, its management controls and Add user", async () => {
    const { restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("dana@example.com")).toBeDefined());
      expect(screen.getByText("Dana")).toBeDefined();
      expect(screen.getByRole("button", { name: "Add user" })).toBeDefined();
      // The manageable row carries the kebab; its three actions are pinned at
      // the component level, so the page only proves the lever is offered.
      expect(screen.getByRole("button", { name: "Actions for dana@example.com" })).toBeDefined();
      // The audit trail is its own page (spec 2026-09-11 §4.4) and must not
      // reappear here.
      expect(screen.queryByText("Audit trail")).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives a member the guidance sentence and fetches NO roster", async () => {
    const { calls, restore } = mockFetch(false);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/for instance admins/)).toBeDefined());
      expect(calls).not.toContain("/api/users");
      expect(screen.queryByRole("button", { name: "Add user" })).toBeNull();
      expect(screen.queryByText("dana@example.com")).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives the service account no controls, even for an admin", async () => {
    // Server-flagged rather than matched on the address here, so the two sides
    // cannot disagree about which account it is.
    const { restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("system@subshell.local")).toBeDefined());
      expect(screen.getByText("Service account")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Actions for system@subshell.local" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("marks a disabled account without hiding what it is", async () => {
    // A disabled admin still reads as an admin — the badge says the role, the
    // indicator says whether they can sign in, and neither answers for the
    // other.
    const { restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("cleo@example.com")).toBeDefined());
      expect(screen.getByText("Disabled")).toBeDefined();
      // A disabled admin still carries the Admin role badge — the two badges
      // answer different questions and neither hides the other. Row-scoped
      // because the viewer's own row also badges Admin.
      const cleoRow = screen.getByText("cleo@example.com").closest("tr");
      expect(cleoRow?.textContent).toContain("Admin");
      // The row is still actionable (the menu's Enable-vs-Disable spelling is
      // pinned at the component level).
      expect(screen.getByRole("button", { name: "Actions for cleo@example.com" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("gives the viewer's own row a label instead of controls", async () => {
    const { restore } = mockFetch(true);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("you@example.com")).toBeDefined());
      expect(screen.getByText("Your account")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Actions for you@example.com" })).toBeNull();
    } finally {
      restore();
    }
  });
});
