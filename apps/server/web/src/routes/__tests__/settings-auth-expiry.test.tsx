import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route } from "@/routes/settings_.auth";

/**
 * The Auth page's pending-approval expiry card (Task 10b, spec §6), driven
 * through the page exactly as `settings-auth-gate.test.tsx` drives the gate:
 * mock the three reads the admin mount makes, assert the card renders the
 * ANSWERED number, and assert saving sends the PATCH body the route stores.
 *
 * Two things it pins beyond "it renders":
 * - the field shows the number the server answered (a corrupt/absent row
 *   already reads 30 server-side; the card just echoes what it is given);
 * - Save PATCHes `{ pendingApprovalExpiryDays: <number> }` to `/api/settings`
 *   — not the string typed, and not to any other route.
 */

const EMAIL_ROW = {
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
  requireApproval: true,
  endpointsResolved: true,
};

/** What `/api/settings` answers; a test that saves re-seats it for the refetch. */
interface Harness {
  patches: { pendingApprovalExpiryDays: number }[];
  restore: () => void;
}

function mockFetch(expiryDays: number): Harness {
  const patches: { pendingApprovalExpiryDays: number }[] = [];
  // The PATCH moves the GET answer, so the invalidate-refetch after a save
  // re-seats the field on what the mock server STORED, exactly like the
  // route's answered read.
  let current = expiryDays;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/settings/public") {
      return new Response(
        JSON.stringify({
          viewerIsAdmin: true,
          allowRegistrations: false,
          appBaseUrl: "https://plane.example",
          trustedOrigins: ["https://plane.example"],
          instanceName: "plane",
          emergencyLoginActive: false,
          serverVersion: "1.5.0",
        }),
      );
    }
    if (url.pathname === "/api/auth-providers") {
      return new Response(JSON.stringify({ providers: [EMAIL_ROW] }));
    }
    if (url.pathname === "/api/settings") {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { pendingApprovalExpiryDays: number };
        patches.push(body);
        current = body.pendingApprovalExpiryDays;
      }
      return new Response(JSON.stringify({ pendingApprovalExpiryDays: current }));
    }
    return new Response(JSON.stringify({}));
  }) as typeof fetch;
  return { patches, restore: () => (globalThis.fetch = original) };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authRoute = Route.update({
    id: "/settings_/auth",
    path: "/settings/auth",
    getParentRoute: () => rootRoute,
  } as never);
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

describe("Auth page pending-expiry card", () => {
  it("renders the saved number the server answered", async () => {
    const { restore } = mockFetch(14);
    try {
      renderPage();
      const input = await waitFor(() => screen.getByLabelText("Pending approvals expire after"));
      expect(input).toHaveProperty("value", "14");
    } finally {
      restore();
    }
  });

  it("saves a changed number via PATCH /api/settings with the parsed value", async () => {
    const { patches, restore } = mockFetch(14);
    try {
      renderPage();
      const input = await waitFor(() => screen.getByLabelText("Pending approvals expire after"));
      fireEvent.change(input, { target: { value: "7" } });
      const save = (await screen.findByRole("button", { name: "Save" })) as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      await waitFor(() => expect(patches).toEqual([{ pendingApprovalExpiryDays: 7 }]));
      // The field re-seats from the invalidated refetch, not from the draft:
      // the save's confirmation is the server's answer coming back.
      await waitFor(() => expect(input).toHaveProperty("value", "7"));
    } finally {
      restore();
    }
  });

  it("accepts 0 (keep forever) and disables Save until the draft changes", async () => {
    const { patches, restore } = mockFetch(14);
    try {
      renderPage();
      const input = await waitFor(() => screen.getByLabelText("Pending approvals expire after"));
      // Unchanged draft: nothing to save (the cast-and-read convention).
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: "0" } });
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      await waitFor(() => expect(patches).toEqual([{ pendingApprovalExpiryDays: 0 }]));
    } finally {
      restore();
    }
  });

  it("refuses a malformed draft loudly, and a valid edit still saves", async () => {
    const { patches, restore } = mockFetch(14);
    try {
      renderPage();
      const input = await waitFor(() => screen.getByLabelText("Pending approvals expire after"));
      const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

      // Characters the number input lets through (HTML floats carry exponent
      // notation): the digits-only rule refuses them, and says so — the error
      // line at the destructive role, Save dark.
      fireEvent.change(input, { target: { value: "1e3" } });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("whole number");
      expect(alert.className).toContain("text-destructive");
      expect(save().disabled).toBe(true);

      // Legal digits beyond the route's ceiling: same refusal, same weight —
      // the card mirrors the bound rather than shipping a doomed PATCH.
      fireEvent.change(input, { target: { value: "3651" } });
      expect(screen.getByRole("alert").textContent).toContain("3650");
      expect(save().disabled).toBe(true);

      // And the path back: a valid draft clears the alert and saves.
      fireEvent.change(input, { target: { value: "7" } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(save().disabled).toBe(false);
      fireEvent.click(save());
      await waitFor(() => expect(patches).toEqual([{ pendingApprovalExpiryDays: 7 }]));
    } finally {
      restore();
    }
  });
});
