import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PasskeysCard } from "@/components/passkeys-card";

/**
 * Self-service passkeys card (spec 2026-08-31 §4). The WebAuthn ceremony
 * (Add passkey → authClient) is browser territory and deliberately not
 * driven here; what IS tested is the card's own I/O over the app's fetch
 * helper: list rendering, empty/error states, and remove-then-refresh.
 */
interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

const realFetch = globalThis.fetch;

/** Stubs fetch; `list` answers the GET, `del` decides the POST's outcome. */
function stubFetch(list: unknown[], del: { ok: boolean; status?: number } = { ok: true }): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("delete-passkey")) {
      return del.ok
        ? Response.json({ success: true })
        : new Response(JSON.stringify({ message: "nope" }), { status: del.status ?? 500 });
    }
    return Response.json(list);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PasskeysCard />
    </QueryClientProvider>,
  );
}

describe("PasskeysCard", () => {
  it("lists registered passkeys by name", async () => {
    stubFetch([
      { id: "pk-1", name: "MacBook Touch ID" },
      { id: "pk-2", name: null },
    ]);
    renderCard();
    await screen.findByText("MacBook Touch ID");
    expect(screen.getByText("Unnamed passkey")).toBeTruthy();
  });

  it("says so when there are none", async () => {
    stubFetch([]);
    renderCard();
    await screen.findByText("No passkeys yet.");
  });

  it("removes a passkey and refetches the list", async () => {
    const calls = stubFetch([{ id: "pk-1", name: "Pixel" }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => {
      const del = calls.find((c) => c.method === "POST");
      expect(del?.url).toContain("delete-passkey");
      expect(del?.body).toContain("pk-1");
    });
    // invalidateQueries must re-run the list GET after a successful delete.
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("surfaces a failed delete without touching the list", async () => {
    const calls = stubFetch([{ id: "pk-1", name: "Pixel" }], { ok: false, status: 500 });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await screen.findByText(/API 500/);
    // A failed delete must not trigger the refresh the successful path does.
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);
  });

  it("shows the error banner with a retry when the list fails to load", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    renderCard();
    await screen.findByText("Couldn't load passkeys.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
