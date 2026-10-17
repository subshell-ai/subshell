import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SharingDialog } from "@/components/sharing-dialog";

/**
 * The owner's sharing dialog (spec §4). Fetches grants + the user roster, lets
 * the owner change a level / add a grantee, and PUTs the whole set on Save. The
 * server interactions are stubbed at `fetch`, so the test drives the same code
 * path the app uses.
 */
function mockFetch(initial: { granteeUserId: string | null; permission: string }[]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname.endsWith("/shares") && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            shares: initial.map((s, i) => ({
              id: `r${i}`,
              granteeUserId: s.granteeUserId,
              granteeName: s.granteeUserId === null ? "Everyone" : s.granteeUserId,
              permission: s.permission,
            })),
          }),
        ),
      );
    }
    if (url.pathname === "/api/users") {
      return Promise.resolve(
        new Response(JSON.stringify({ viewerIsAdmin: true, users: [{ id: "u2", email: "bob@subshell.local" }] })),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ shares: [] })));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SharingDialog subshellId="s1" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("SharingDialog", () => {
  it("renders existing grants with their names and levels", async () => {
    const { restore } = mockFetch([{ granteeUserId: null, permission: "view" }]);
    try {
      renderDialog();
      // The grant row renders (Everyone, one Remove control); the add-row
      // picker omits Everyone since it's already shared.
      expect(await screen.findByText("Everyone")).toBeDefined();
      expect(screen.getByRole("button", { name: /^Remove access for/ })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("disables Save until access changes and disables it again when changes are undone", async () => {
    const { calls, restore } = mockFetch([{ granteeUserId: null, permission: "view" }]);
    try {
      renderDialog();
      await screen.findByText("Everyone");
      const save = () => screen.getByRole("button", { name: "Save" });
      const disabled = () => save().matches(":disabled, [aria-disabled=true]");
      await waitFor(() => expect(disabled()).toBe(true));
      fireEvent.click(save());
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
      fireEvent.click(screen.getByRole("combobox", { name: "Access for Everyone" }));
      const editOption = await screen.findByRole("option", { name: "View + edit" });
      fireEvent.pointerDown(editOption);
      fireEvent.pointerUp(editOption);
      fireEvent.click(editOption);
      await waitFor(() => expect(disabled()).toBe(false));
      fireEvent.click(screen.getByRole("combobox", { name: "Access for Everyone" }));
      const viewOption = await screen.findByRole("option", { name: "View" });
      fireEvent.pointerDown(viewOption);
      fireEvent.pointerUp(viewOption);
      fireEvent.click(viewOption);
      await waitFor(() => expect(disabled()).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "Remove access for Everyone" }));
      await waitFor(() => expect(disabled()).toBe(false));
      // Re-adding the original grant also restores the saved state.
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(disabled()).toBe(true));
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
    } finally {
      restore();
    }
  });

  it("adding a user and saving PUTs the merged grant set", async () => {
    const { calls, restore } = mockFetch([{ granteeUserId: null, permission: "view" }]);
    try {
      renderDialog();
      await screen.findByText("Everyone");
      // Choose bob from the roster, then Add.
      const picker = screen.getByRole("combobox", { name: "Share with" });
      fireEvent.mouseDown(picker);
      fireEvent.click(picker);
      await screen.findByRole("option", { name: "bob@subshell.local" });
      fireEvent.change(picker, { target: { value: "nobody-matches" } });
      await screen.findByText("No matching people to add.");
      fireEvent.change(picker, { target: { value: "bob" } });
      fireEvent.click(await screen.findByRole("option", { name: "bob@subshell.local" }));
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByText("bob@subshell.local")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/shares"));
        expect(put).toBeDefined();
        const body = JSON.parse(put?.body ?? "{}") as { shares: { granteeUserId: string | null }[] };
        const ids = body.shares.map((s) => s.granteeUserId).sort();
        expect(ids).toEqual([null, "u2"].sort());
      });
    } finally {
      restore();
    }
  });

  it("removing a grant PUTs the set without it", async () => {
    const { calls, restore } = mockFetch([{ granteeUserId: null, permission: "view" }]);
    try {
      renderDialog();
      await screen.findByText("Everyone");
      fireEvent.click(screen.getByRole("button", { name: /^Remove access for/ }));
      // No unsaved-changes sentence (design rule: Save's disabled state carries
      // that fact); the empty state names the PENDING result instead.
      expect(screen.queryByText(/unsaved/i)).toBeNull();
      expect(screen.getByText("No one will have shared access after you save.")).toBeTruthy();
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/shares"));
        const body = JSON.parse(put?.body ?? "{}") as { shares: unknown[] };
        expect(body.shares).toEqual([]);
      });
    } finally {
      restore();
    }
  });
});
