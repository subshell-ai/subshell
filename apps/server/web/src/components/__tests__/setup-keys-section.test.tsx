import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";
import { setConfirmHandler } from "@/lib/confirm";

interface Row {
  id: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

/**
 * Serves the list route with the rows a test names, and records every DELETE.
 * The card reads `GET /api/nodes/setup-keys` and nothing else, so this is the
 * whole backend it sees.
 */
function mockKeys(rows: Row[]) {
  const deletes: string[] = [];
  const confirmations: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if ((init?.method ?? "GET") === "DELETE") {
      deletes.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    return Promise.resolve(new Response(JSON.stringify({ keys: rows }), { status: 200 }));
  }) as typeof fetch;
  const previous = setConfirmHandler((options) => {
    confirmations.push(options.title);
    return Promise.resolve(true);
  });
  return {
    deletes,
    confirmations,
    restore: () => {
      globalThis.fetch = original;
      setConfirmHandler(previous);
    },
  };
}

function renderCard(rows: Row[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SetupKeysSection />
    </QueryClientProvider>,
  );
  return rows;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "k1",
  key: "nsk_alpha_alpha_alpha_alpha_1",
  createdAt: "2026-09-17T10:00:00.000Z",
  expiresAt: FUTURE,
  usedAt: null,
  consumedNodeId: null,
  ...over,
});

beforeEach(() => setConfirmHandler(null));
afterEach(cleanup);

describe("SetupKeysSection", () => {
  it("lists each key's OWN TEXT, with a copy affordance", async () => {
    // The row used to be titled by the label the Add-node dialog asked for. That
    // question is gone, so the key is the identity of the row — and reading it
    // back here is the reason it is stored in the clear at all.
    const { restore } = mockKeys([row()]);
    try {
      renderCard([row()]);
      expect(await screen.findByText("nsk_alpha_alpha_alpha_alpha_1")).toBeDefined();
      expect(screen.getByRole("button", { name: "Copy setup key" })).toBeDefined();
      expect(screen.getByText(/Single-use enrollment credentials/i)).toBeDefined();
      expect(screen.queryByText(/shown once/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("badges unused, used and expired, and names the node a used key enrolled", async () => {
    const { restore } = mockKeys([
      row({ id: "a", key: "nsk_unused_unused_unused_unused_1", usedAt: null }),
      row({
        id: "b",
        key: "nsk_used_used_used_used_used_1x",
        usedAt: "2026-09-17T11:00:00.000Z",
        consumedNodeId: "n7",
      }),
      row({ id: "c", key: "nsk_stale_stale_stale_stale_sta_1", expiresAt: PAST }),
    ]);
    try {
      renderCard([]);
      await screen.findByText("nsk_unused_unused_unused_unused_1");
      expect(screen.getByText("unused")).toBeDefined();
      expect(screen.getByText("used")).toBeDefined();
      expect(screen.getByText("expired")).toBeDefined();
      expect(screen.getByText(/enrolled n7/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("revoking confirms with the KEY and deletes that row", async () => {
    const { restore, deletes, confirmations } = mockKeys([row()]);
    try {
      renderCard([row()]);
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
      await waitFor(() => expect(deletes).toEqual(["/api/nodes/setup-keys/k1"]));
      // The prompt names what is about to stop working by the same text the row
      // shows — there is no label to name it by any more.
      expect(confirmations[0]).toContain("nsk_alpha_alpha_alpha_alpha_1");
    } finally {
      restore();
    }
  });

  it("says so when nothing has been minted", async () => {
    const { restore } = mockKeys([]);
    try {
      renderCard([]);
      expect(await screen.findByText("No setup keys yet.")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("re-renders from the refetch a mint triggers", async () => {
    // The dialog mints, the card shows. One query key, so the card cannot lag the
    // dialog by more than the refetch — this is the pair the operator reads as
    // "the key is not lost when the dialog closes".
    let rows: Row[] = [];
    const original = globalThis.fetch;
    const serve = () => Promise.resolve(new Response(JSON.stringify({ keys: rows }), { status: 200 }));
    globalThis.fetch = serve as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      render(
        <QueryClientProvider client={client}>
          <SetupKeysSection />
        </QueryClientProvider>,
      );
      await screen.findByText("No setup keys yet.");
      rows = [row()];
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["node-setup-keys"] });
      });
      expect(await screen.findByText("nsk_alpha_alpha_alpha_alpha_1")).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
