import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PendingUsersTable } from "@/components/users/pending-users-table";
import type { PendingUserRow } from "@/hooks/use-users-pending";

/**
 * The approval queue table (spec 2026-09-24 §6/§8). What this component must
 * get right is mostly WHAT IT OFFERS: exactly one PATCH shape per decision,
 * no dialog (neither act locks anyone out), no delete affordance at all
 * (Rejected rows stay on purpose), a Rejected row that cannot be rejected
 * again, and the server's 409 sentence rendered verbatim on the row that
 * asked for it.
 */

function row(over: Partial<PendingUserRow> & { id: string }): PendingUserRow {
  return {
    email: `${over.id}@example.com`,
    name: over.id,
    providerId: "google",
    providerName: "Google",
    arrivedAt: "2026-09-24T10:00:00.000Z",
    approvalState: "pending",
    ...over,
  };
}

interface Patched {
  url: string;
  body: unknown;
}

/** Captures every PATCH and answers it with `response()`; anything else is an empty 200. */
function mockFetch(response: () => Response): { patches: Patched[]; restore: () => void } {
  const patches: Patched[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "PATCH") {
      patches.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
      return Promise.resolve(response());
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return {
    patches,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body));

function renderTable(rows: PendingUserRow[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PendingUsersTable rows={rows} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("PendingUsersTable", () => {
  it("approves with one PATCH carrying approvalState=approved, no dialog", async () => {
    const { patches, restore } = mockFetch(() => ok());
    try {
      renderTable([row({ id: "a1" })]);
      fireEvent.click(screen.getByRole("button", { name: "Approve a1@example.com" }));
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/a1/approval");
      expect(patches[0]?.body).toEqual({ approvalState: "approved" });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      restore();
    }
  });

  it("rejects with one PATCH carrying approvalState=rejected", async () => {
    const { patches, restore } = mockFetch(() => ok());
    try {
      renderTable([row({ id: "a2" })]);
      fireEvent.click(screen.getByRole("button", { name: "Reject a2@example.com" }));
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/a2/approval");
      expect(patches[0]?.body).toEqual({ approvalState: "rejected" });
    } finally {
      restore();
    }
  });

  it("badges a rejected row and offers it Approve but not a second Reject", () => {
    // Rejecting an already-rejected row would rewrite the state it has; the
    // row stays as the record, and Approve is the only way out (spec §6).
    renderTable([row({ id: "a3", approvalState: "rejected", arrivedAt: null })]);
    const tr = screen.getByText("a3@example.com").closest("tr");
    expect(tr?.textContent).toContain("Rejected");
    expect(screen.queryByRole("button", { name: "Reject a3@example.com" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve a3@example.com" })).toBeDefined();
    // A resolved rejection carries no arrival stamp; it reads as an em dash,
    // not a fake date.
    expect(tr?.textContent).toContain("—");
  });

  it("renders a deleted provider as a standing label, not a vanished row", () => {
    // The backend sends providerName null when the provider is gone; the queue is
    // the record of who knocked at a provider this instance used to have.
    renderTable([row({ id: "a4", providerId: "old-sso", providerName: null })]);
    const tr = screen.getByText("a4@example.com").closest("tr");
    expect(tr?.textContent).toContain("Removed provider");
  });

  it("shows the server's APPROVAL_NOOP sentence on the row, verbatim", async () => {
    const { restore } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            message: "That account is already approved. Approval only answers queue arrivals.",
          }),
          { status: 409 },
        ),
    );
    try {
      renderTable([row({ id: "a5" })]);
      fireEvent.click(screen.getByRole("button", { name: "Approve a5@example.com" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That account is already approved"));
    } finally {
      restore();
    }
  });

  it("locks the row's buttons while a decision is in flight", async () => {
    let release: (() => void) | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          release = () => resolve(ok());
        });
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as typeof fetch;
    try {
      renderTable([row({ id: "a6" })]);
      fireEvent.click(screen.getByRole("button", { name: "Approve a6@example.com" }));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Reject a6@example.com" }) as HTMLButtonElement).disabled).toBe(
          true,
        ),
      );
      release?.();
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Approve a6@example.com" }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
