import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { type UserRow, UsersTable } from "@/components/users/users-table";
import { setFetchRouter } from "@/test-setup";

/**
 * The roster table's Actions-column contract (spec 2026-09-24-users-table-
 * manage-column): manageable rows get the kebab, the viewer's row and the
 * server-marked service row get a muted label instead, and NO visible column
 * title sits above either — the header is the Nodes table's, unnamed to the
 * eye and "Actions" to a screen reader.
 *
 * Session routing goes through `setFetchRouter` because `useCurrentUser`
 * binds fetch at module evaluation; see `src/test-setup.ts`.
 */

function user(over: Partial<UserRow> & { id: string }): UserRow {
  return { name: over.id, email: `${over.id}@example.com`, role: "user", createdAt: null, ...over };
}

/** A signed-in session whose id matches the self row's, so that row resolves
 * to its label. Every caller pairs this with a `me` user id. */
function stubSession(id: string): void {
  setFetchRouter(async (input) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("get-session") ? { user: { id, name: "Viewer", email: "viewer@example.com" } } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function renderTable(users: UserRow[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsersTable users={users} onChanged={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
});

describe("UsersTable", () => {
  it("names the actions column to screen readers only", async () => {
    stubSession("me");
    renderTable([user({ id: "u2" })]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Actions for u2@example.com" })).toBeDefined());
    expect(screen.queryByRole("columnheader", { name: "Manage" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeDefined();
  });

  it("renders the service row as a label, not a lever", async () => {
    stubSession("me");
    renderTable([user({ id: "svc", email: "system@subshell.local", manageable: false })]);
    await waitFor(() => expect(screen.getByText("Service account")).toBeDefined());
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("renders the viewer's own row as a label once the session resolves", async () => {
    stubSession("me");
    renderTable([user({ id: "me", role: "admin" })]);
    // While the session is unresolved the row shows its controls (viewerId
    // null shows rather than hides — a deliberate rule this component tests);
    // once it lands, the self row must lose the kebab and keep the label.
    await waitFor(() => expect(screen.getByText("Your account")).toBeDefined());
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  describe("Provider column", () => {
    /** The one row's text, once its session has resolved. */
    async function renderOne(over: Partial<UserRow> & { id: string }): Promise<string> {
      stubSession("me");
      renderTable([user(over)]);
      const tr = (await screen.findByText(`${over.id}@example.com`)).closest("tr");
      return tr?.textContent ?? "";
    }

    it("badges both doors when an account has both", async () => {
      const text = await renderOne({ id: "both", providers: ["credential", "google"] });
      expect(text).toContain("Email");
      expect(text).toContain("Google");
    });

    it("badges only the door for a google-only account", async () => {
      // "Email" is the credential door's word (spelled like the Auth page's
      // kind label), and a door-only arrival must not borrow it.
      const text = await renderOne({ id: "goned", providers: ["google"] });
      expect(text).toContain("Google");
      expect(text).not.toContain("Email");
    });

    it("renders an unknown door id verbatim", async () => {
      // A custom OIDC door's admin-chosen name is not in this payload; the id
      // is the honest fallback rather than a guess.
      const text = await renderOne({ id: "oidc", providers: ["acme-sso"] });
      expect(text).toContain("acme-sso");
    });

    it("renders nothing where the field is absent, and nothing for an empty set", async () => {
      // Absent = an older payload; empty = the payload's own answer (the
      // `system` account has no sign-in row). Both read as an empty cell.
      const absent = await renderOne({ id: "old" });
      expect(absent).not.toContain("Email");
      const empty = await renderOne({ id: "svc", providers: [] });
      expect(empty).not.toContain("Email");
    });
  });
});
