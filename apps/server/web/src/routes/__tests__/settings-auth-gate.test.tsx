import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/settings_.auth";
import type { ProviderAdminView } from "@/types/auth-provider";

/**
 * The Auth page's gate, the `server-status.test.tsx` idiom: a non-admin mount
 * must fire NO request to the admin provider endpoint. `GET /api/auth-providers`
 * is cookie-admin, so a doomed 403 is what an ungated query would send on
 * every member's page view — the providers query is `enabled` on the
 * server-derived `viewerIsAdmin`, and this file is what pins that.
 */

const EMAIL_ROW: ProviderAdminView = {
  id: "email",
  kind: "email",
  name: "Email",
  issuer: null,
  clientId: null,
  hasSecret: false,
  entryOrigins: [],
  allowedDomains: null,
  enabled: true,
  signInEnabled: true,
  registrationEnabled: null,
  requireApproval: false,
  endpointsResolved: true,
};

const OIDC_ROW: ProviderAdminView = {
  id: "work",
  kind: "oidc",
  name: "Work SSO",
  issuer: "https://id.example",
  clientId: "cid",
  hasSecret: true,
  entryOrigins: ["https://plane.example"],
  allowedDomains: [],
  enabled: true,
  signInEnabled: true,
  registrationEnabled: false,
  requireApproval: false,
  endpointsResolved: true,
};

/**
 * @param viewerIsAdmin - what `/api/settings/public` reports
 * @param providers - the provider list, or null to 403 that route
 * @param hangPublic - never settle the settings read (the `undefined` gate state)
 */
function mockFetch(viewerIsAdmin: boolean, providers: ProviderAdminView[] | null, hangPublic = false) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname);
    if (url.pathname === "/api/settings/public") {
      if (hangPublic) return new Promise<Response>(() => {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            viewerIsAdmin,
            allowRegistrations: false,
            appBaseUrl: "https://plane.example",
            trustedOrigins: ["https://plane.example"],
            instanceName: "plane",
            emergencyLoginActive: false,
            serverVersion: "1.5.0",
          }),
        ),
      );
    }
    if (url.pathname === "/api/auth-providers") {
      if (providers === null) return Promise.resolve(new Response("forbidden", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify({ providers })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // Re-parented onto a test root, as in server-status.test.tsx.
  const authRoute = Route.update({
    id: "/settings_/auth",
    path: "/settings/auth",
    getParentRoute: () => rootRoute,
  } as any);
  const router = createRouter({
    routeTree: rootRoute.addChildren([authRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/auth"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("Auth page gate", () => {
  it("does NOT request the provider endpoint for a non-admin", async () => {
    const { calls, restore } = mockFetch(false, null);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText(/for instance admins/)).toBeDefined());
      expect(calls.some((c) => c === "/api/auth-providers")).toBe(false);
      // The add affordance is admin-only too — clicking it would open a
      // dialog whose every write is a doomed 403.
      expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("requests NOTHING while viewerIsAdmin is still undefined", async () => {
    // The loading state counts as NOT admin: the providers query must wait
    // for the server's answer, not guess from absence.
    const { calls, restore } = mockFetch(true, null, true);
    try {
      renderPage();
      await waitFor(() => expect(calls.some((c) => c === "/api/settings/public")).toBe(true));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.some((c) => c === "/api/auth-providers")).toBe(false);
    } finally {
      restore();
    }
  });

  it("renders the table for an admin, and the email row states the CLOSED gate honestly", async () => {
    const { calls, restore } = mockFetch(true, [EMAIL_ROW, OIDC_ROW]);
    try {
      renderPage();
      await waitFor(() => expect(screen.getByText("Work SSO")).toBeDefined());
      expect(calls.some((c) => c === "/api/auth-providers")).toBe(true);
      // The email row's null flag on a closed instance reads closed, not open:
      // the review round's contradiction, pinned end to end.
      expect(screen.getByText("Automatically closed once the first account signed up")).toBeDefined();
    } finally {
      restore();
    }
  });
});
