import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SetupKeysSection } from "@/components/nodes/setup-keys-section";

interface Row {
  id: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
  /** The admin `?all=1` read's additions; absent on the owner-scoped shape. */
  ownerUserId?: string;
  ownerLabel?: string;
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

/**
 * Serves the list route with the rows a test names, and records every DELETE
 * and GET. The card reads `GET /api/nodes/setup-keys` (or `?all=1` when an
 * admin flips the switch) plus `GET /api/settings/public` for `viewerIsAdmin`
 * — those two are the whole backend it sees.
 */
function mockKeys(rows: Row[], opts: { viewerIsAdmin?: boolean; allRows?: Row[] } = {}) {
  const deletes: string[] = [];
  const gets: string[] = [];
  const confirmations: {
    title: string;
    description?: string;
    confirmLabel?: string;
    danger?: boolean;
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if ((init?.method ?? "GET") === "DELETE") {
      deletes.push(url.pathname);
      // The server forgets the key; the mock forgets it in BOTH shapes it serves,
      // so a test can observe WHICH list the mutation's invalidation re-reads.
      const id = url.pathname.split("/").pop();
      for (const list of opts.allRows ? [rows, opts.allRows] : [rows]) {
        const i = list.findIndex((k) => k.id === id);
        if (i >= 0) list.splice(i, 1);
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    gets.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/settings/public") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            allowRegistrations: true,
            emergencyLoginActive: false,
            instanceName: "test",
            appBaseUrl: "http://localhost:3080",
            viewerIsAdmin: opts.viewerIsAdmin ?? false,
            serverVersion: "0.0.0",
          }),
          { status: 200 },
        ),
      );
    }
    if (url.searchParams.get("all") === "1") {
      return Promise.resolve(new Response(JSON.stringify({ keys: opts.allRows ?? rows }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ keys: rows }), { status: 200 }));
  }) as typeof fetch;
  const previous = setConfirmHandler((options) => {
    confirmations.push(options);
    return Promise.resolve(true);
  });
  return {
    deletes,
    gets,
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

  it("revoking names the act in the title and the key in the body", async () => {
    const { restore, deletes, confirmations } = mockKeys([row()]);
    try {
      renderCard([row()]);
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
      await waitFor(() => expect(deletes).toEqual(["/api/nodes/setup-keys/k1"]));
      // Operator, 2026-09-22, on the live window: "Can we not have the key in
      // the title? It looks really awful." The question names the act; the
      // forty-three-character token it refers to is quoted in the
      // description, which is where a long mono value reads as a detail
      // rather than a wrapped blob where a question should be.
      expect(confirmations[0].title).toBe("Revoke this setup key?");
      expect(confirmations[0].description).toContain("nsk_alpha_alpha_alpha_alpha_1");
      expect(confirmations[0].confirmLabel).toBe("Revoke");
      expect(confirmations[0].danger).toBe(true);
    } finally {
      restore();
    }
  });

  it("says REMOVE on a settled row, because a spent key has nothing to revoke", async () => {
    // Same ruling's second screenshot: the USED row's button read "Revoke",
    // naming an act that can no longer happen. The verb follows the state;
    // the dialog says plainly that only the record goes; the destructive
    // styling belongs to closing a live door, not to list tidying.
    const { restore, deletes, confirmations } = mockKeys([
      row({
        id: "b",
        key: "nsk_used_used_used_used_used_1x",
        usedAt: "2026-09-17T11:00:00.000Z",
        consumedNodeId: "n7",
      }),
    ]);
    try {
      renderCard([]);
      await screen.findByText("nsk_used_used_used_used_used_1x");
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(deletes).toEqual(["/api/nodes/setup-keys/b"]));
      expect(confirmations[0].title).toBe("Remove this setup key?");
      expect(confirmations[0].description).toContain("used, so there is nothing to revoke");
      expect(confirmations[0].confirmLabel).toBe("Remove");
      expect(confirmations[0].danger).toBe(false);
    } finally {
      restore();
    }
  });

  it("offers Setup on the key that still works, and rebuilds the command around THAT key", async () => {
    // The card lists the key so it is not lost; until this button existed the
    // COMMAND was still lost with the dialog, and the only way to re-read it was to
    // mint a second single-use key for instructions that had never actually gone
    // away. So the assertion is the whole point: the row's own key, not a new one.
    const { restore } = mockKeys([
      row(),
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
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      // One button, beside the usable row alone: steps for a redeemed or expired key
      // would walk someone to a 401 they cannot act on.
      expect(screen.getAllByRole("button", { name: "Setup" })).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Setup" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Set up a machine with this key")).toBeDefined();
      expect(within(dialog).getByText(/setup_key=nsk_alpha_alpha_alpha_alpha_1/)).toBeDefined();
      expect(within(dialog).queryByText(/nsk_used_used/)).toBeNull();

      // The same key down the other path, where the app is handed values rather than
      // a command — the address picker above the switch is what both of them need.
      fireEvent.click(within(dialog).getByRole("button", { name: "Desktop App" }));
      expect(within(dialog).getByRole("button", { name: "Copy setup key" })).toBeDefined();
      expect(within(dialog).getByRole("button", { name: "Copy server address" })).toBeDefined();
      expect(within(dialog).getByText("nsk_alpha_alpha_alpha_alpha_1")).toBeDefined();
      // The other half of the shared `NodeKeySetup` contract: this surface always
      // HAS a key, so it passes no generate slot and shows no placeholder —
      // pinned as absences the way the Add-node dialog pins the placeholders.
      expect(within(dialog).queryByRole("button", { name: "Generate setup key" })).toBeNull();
      expect(within(dialog).queryByText("Generate setup key first")).toBeNull();

      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  // Audit 2026-09 item 4: an admin's instance-wide view and foreign revoke,
  // behind the server's own `viewerIsAdmin` flag.
  it("shows no all-accounts switch to a plain user, and fires no all-accounts request", async () => {
    const { restore, gets } = mockKeys([row()], { viewerIsAdmin: false });
    try {
      renderCard([row()]);
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      expect(screen.queryByRole("switch")).toBeNull();
      // Not just the control: the widening must never even be REQUESTED by a
      // viewer who cannot use it. The hook is `enabled: isAdmin && showAll`,
      // and this is the request-side proof of that gate.
      expect(gets.some((g) => g.includes("all=1"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("a foreign revoke refreshes the all-accounts list in place", async () => {
    // The revoke's invalidation rides the shared prefix, so the list the admin
    // is LOOKING AT re-reads — the foreign row disappears without the toggle
    // being touched. The sibling test's toggle-back cannot see this: re-enabling
    // the narrow read would hide a stale all-list behind a fresh one.
    const mine = row();
    const foreign = row({
      id: "f1",
      key: "nsk_foreign_foreign_foreign_fore_1",
      ownerUserId: "u_bob",
      ownerLabel: "bob@subshell.local",
    });
    const allRows = [mine, foreign];
    const { restore, gets } = mockKeys([mine], { viewerIsAdmin: true, allRows });
    try {
      renderCard([]);
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      fireEvent.click(screen.getByRole("switch", { name: "List every account's setup keys" }));
      await screen.findByText("nsk_foreign_foreign_foreign_fore_1");
      const allGetsBefore = gets.filter((g) => g.includes("all=1")).length;

      const foreignCard = screen
        .getByText("nsk_foreign_foreign_foreign_fore_1")
        .closest("div.space-y-2") as HTMLElement;
      fireEvent.click(within(foreignCard).getByRole("button", { name: "Revoke" }));

      // Still in all-mode — the row is gone because the list RE-READ, not because
      // the view changed. The pump is load-bearing, not ceremony: the refetch's
      // commit lands on React's act queue outside any act scope, and `waitFor`'s
      // poll never creates a boundary to flush it (the `act` around the mint's
      // invalidate above is the same lesson, written the other way).
      await waitFor(async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(screen.queryByText("nsk_foreign_foreign_foreign_fore_1")).toBeNull();
      });
      expect(gets.filter((g) => g.includes("all=1")).length).toBeGreaterThan(allGetsBefore);
      expect(screen.getByText("nsk_alpha_alpha_alpha_alpha_1")).toBeDefined();
      expect(screen.getByRole("switch", { name: "List every account's setup keys" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("an admin can list every account's keys, each naming its creator, and revoke a foreign row", async () => {
    const mine = row();
    const foreign = row({
      id: "f1",
      key: "nsk_foreign_foreign_foreign_fore_1",
      ownerUserId: "u_bob",
      ownerLabel: "bob@subshell.local",
    });
    // Own list vs all list: distinct payloads, so the assertion can tell WHICH
    // read produced the row on screen — the card must not blend them.
    const { restore, gets, deletes } = mockKeys([mine], { viewerIsAdmin: true, allRows: [mine, foreign] });
    try {
      renderCard([]);
      await screen.findByText("nsk_alpha_alpha_alpha_alpha_1");
      const toggle = screen.getByRole("switch", { name: "List every account's setup keys" });
      // The widening must not fire until asked: the admin read is opt-in per
      // mount, never an incidental second request on page load.
      expect(gets.some((g) => g.includes("all=1"))).toBe(false);
      expect(screen.queryByText("nsk_foreign_foreign_foreign_fore_1")).toBeNull();

      fireEvent.click(toggle);
      await screen.findByText("nsk_foreign_foreign_foreign_fore_1");
      expect(gets.some((g) => g.includes("/api/nodes/setup-keys?all=1"))).toBe(true);
      // Whose door it is, on the row itself.
      expect(screen.getByText(/by bob@subshell.local/)).toBeDefined();

      // The same Revoke verb closes the foreign row — that is the whole fix.
      const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
      expect(revokeButtons).toHaveLength(2);
      const foreignCard = screen.getByText("nsk_foreign_foreign_foreign_fore_1").closest("div.space-y-2");
      fireEvent.click(within(foreignCard as HTMLElement).getByRole("button", { name: "Revoke" }));
      await waitFor(() => expect(deletes).toEqual(["/api/nodes/setup-keys/f1"]));

      // And switching back returns to the narrow read.
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.queryByText("nsk_foreign_foreign_foreign_fore_1")).toBeNull());
    } finally {
      restore();
    }
  });
});
