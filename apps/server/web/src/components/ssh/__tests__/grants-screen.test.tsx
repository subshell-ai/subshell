import { afterEach, describe, expect, it } from "bun:test";
import { type ConfirmOptions, setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GrantsScreen } from "@/components/ssh/grants-screen";

/**
 * The grants screen (spec 2026-10-08 §6.1, §8): the owner's standing key
 * grants, their selected agent identities, and the instant-both-ways revoke.
 * The revoke is the screen's one destructive act, so its confirm is pinned:
 * a STATIC title (the ruling 2026-09-30: the name rides the body) and a
 * refusal of the DELETE rendered red on the row that failed.
 */

const FP_ONE = `SHA256:${"A".repeat(43)}`;
const FP_TWO = `SHA256:${"B".repeat(43)}`;

const GRANT = {
  id: "g1",
  name: "prod keys",
  keyHomeNodeId: "nodeA",
  resolvedSelector: "*.prod.example.com",
  fingerprints: [FP_ONE, FP_TWO],
  createdVia: "first-use",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
};

interface Sent {
  method: string;
  path: string;
}

function stubFetch(
  restore: (undo: () => void) => void,
  opts: { revokeStatus?: number; revokeMessage?: string } = {},
): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  restore(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    sent.push({ method, path: url.pathname });
    if (url.pathname === "/api/ssh/grants") {
      return new Response(JSON.stringify({ grants: [GRANT] }), { status: 200 });
    }
    if (url.pathname === "/api/nodes") {
      return new Response(JSON.stringify({ nodes: [{ id: "nodeA", name: "vault" }] }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grants/g1" && method === "DELETE") {
      if (opts.revokeStatus) {
        return new Response(JSON.stringify({ message: opts.revokeMessage ?? "gone" }), {
          status: opts.revokeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return sent;
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

function mockConfirm(answer: boolean) {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(answer);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GrantsScreen />
    </QueryClientProvider>,
  );
}

describe("GrantsScreen", () => {
  it("lists each grant with its machine, selector and selected fingerprints", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText("prod keys")).toBeDefined();
    // The key home reads by NAME (rail doctrine: nothing rendered derives from the id).
    // The row's one detail line carries machine and selector, `machine · selector`.
    expect(screen.getByText(/vault/)).toBeDefined();
    expect(screen.getByText(/\*\.prod\.example\.com/)).toBeDefined();
    expect(screen.getByText(FP_ONE)).toBeDefined();
    expect(screen.getByText(FP_TWO)).toBeDefined();
  });

  it("says so plainly when there is nothing standing", async () => {
    const original = globalThis.fetch;
    restores.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (input: unknown) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const body = path === "/api/ssh/grants" ? { grants: [] } : { nodes: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof globalThis.fetch;
    renderScreen();
    expect(await screen.findByText(/No key grants yet/)).toBeDefined();
  });

  it("revokes only after a confirm whose title is static, DELETEing the row", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const confirm = mockConfirm(true);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    await waitFor(() => expect(confirm.seen.length).toBe(1));
    // Static title (design ruling 2026-09-30): the grant's name rides the body, never the heading.
    expect(confirm.seen[0]?.title).toBe("Revoke this grant?");
    expect(confirm.seen[0]?.description).toContain("prod keys");
    await waitFor(() => expect(sent.some((s) => s.method === "DELETE" && s.path === "/api/ssh/grants/g1")).toBe(true));
  });

  it("sends nothing when the confirm is declined", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const confirm = mockConfirm(false);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    await waitFor(() => expect(confirm.seen.length).toBe(1));
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("renders a refused revoke as the row's own red line", async () => {
    stubFetch(
      (undo) => {
        restores.push(undo);
      },
      { revokeStatus: 404, revokeMessage: "No such grant" },
    );
    const confirm = mockConfirm(true);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No such grant");
    expect(alert.className).toContain("text-destructive");
  });
});
