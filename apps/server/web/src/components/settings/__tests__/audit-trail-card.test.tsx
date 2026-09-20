import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuditTrailCard } from "@/components/settings/audit-trail-card";

/**
 * The audit trail (spec 2026-09-11 §4.4), moved off `/users` onto its own
 * page. Its whole job is the three-way distinction the roster taught it:
 * "couldn't load" is not "nothing happened" is not "still asking". Collapsing
 * any pair of those makes a broken read look like a quiet instance, which is
 * the one thing an audit log must never do.
 */
const EVENT = {
  id: "ev-1",
  actorUserId: "admin-1",
  action: "user.create",
  targetType: "user",
  targetId: "0123456789abcdef",
  metadata: { email: "dana@example.com" },
  createdAt: "2026-09-11T10:00:00.000Z",
};

/** Answers `/api/audit` with one canned outcome; nothing else is requested. */
function mockFetch(answer: (url: URL) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/audit") return answer(url);
    throw new Error(`unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** One recorded event, stamped and numbered so page order is checkable. */
function eventAt(n: number) {
  return {
    ...EVENT,
    id: `ev-${n}`,
    // Descending in n: the trail reads newest first, so ev-0 is the top row.
    createdAt: new Date(Date.parse("2026-09-11T10:00:00.000Z") - n * 1000).toISOString(),
  };
}

/** A full page (25) of events, newest first. */
function fullPage() {
  return Array.from({ length: 25 }, (_, i) => eventAt(i));
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuditTrailCard />
    </QueryClientProvider>,
  );
}

describe("AuditTrailCard", () => {
  let restore: () => void = () => {};
  afterEach(() => {
    restore();
    cleanup();
  });

  it("says it is still asking, rather than showing an empty trail", () => {
    // A never-settling request: the first paint is the one under test, so no
    // await — an "Loading…" that only appeared after the answer would be
    // indistinguishable from the empty state to a reader.
    restore = mockFetch(() => new Promise<Response>(() => {}));
    renderCard();
    expect(screen.getByText("Loading…")).toBeDefined();
    expect(screen.queryByText("No events recorded yet.")).toBeNull();
  });

  it("says the read failed, never that nothing happened", async () => {
    restore = mockFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    renderCard();
    await waitFor(() => expect(screen.getByText(/Couldn't load the audit trail/)).toBeDefined());
    expect(screen.queryByText("No events recorded yet.")).toBeNull();
  });

  it("distinguishes a genuinely empty trail", async () => {
    restore = mockFetch(() => Promise.resolve(new Response(JSON.stringify([]))));
    renderCard();
    await waitFor(() => expect(screen.getByText("No events recorded yet.")).toBeDefined());
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("renders an event's action, truncated target and context", async () => {
    restore = mockFetch(() => Promise.resolve(new Response(JSON.stringify([EVENT]))));
    renderCard();
    await waitFor(() => expect(screen.getByText("user.create")).toBeDefined());
    // Eight characters of the id, enough to recognize and not enough to fill
    // the column — the shape the /users table established.
    expect(screen.getByText("user:01234567")).toBeDefined();
    expect(screen.getByText(JSON.stringify(EVENT.metadata))).toBeDefined();
    expect(screen.queryByText("No events recorded yet.")).toBeNull();
  });
});

describe("AuditTrailCard paging", () => {
  let restore: () => void = () => {};
  afterEach(() => {
    restore();
    cleanup();
  });

  /** Serves `pageFor(search)` per request and records every search string. */
  function mockPages(pageFor: (search: URLSearchParams) => unknown[]) {
    const seen: URLSearchParams[] = [];
    restore = mockFetch((url) => {
      seen.push(url.searchParams);
      return Promise.resolve(new Response(JSON.stringify(pageFor(url.searchParams))));
    });
    return seen;
  }

  it("asks for a PAGE (25), not the whole trail, and pages of one are not offered", async () => {
    const seen = mockPages(() => fullPage());
    renderCard();
    await waitFor(() => expect(screen.getByText("Page 1")).toBeDefined());
    expect(seen[0].get("limit")).toBe("25");
    expect(seen[0].get("beforeCreatedAt")).toBeNull();
    // A full page means more may exist: Older is live, Newer cannot be.
    expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Newer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a single short page is the whole trail — no pager at all", async () => {
    mockPages(() => [EVENT]);
    renderCard();
    await waitFor(() => expect(screen.getByText("user.create")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Newer" })).toBeNull();
  });

  it("pages Older with the last row's (createdAt, id) pair, and Newer walks back", async () => {
    const last = eventAt(24);
    const seen = mockPages((params) => (params.has("beforeId") ? [eventAt(25)] : fullPage()));
    renderCard();
    await waitFor(() => expect(screen.getByText("Page 1")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(screen.getByText("Page 2")).toBeDefined());
    // The cursor is the page-above's LAST row, both halves — a timestamp
    // alone would skip or repeat events sharing its millisecond.
    expect(seen[1].get("beforeCreatedAt")).toBe(last.createdAt);
    expect(seen[1].get("beforeId")).toBe(last.id);
    expect((screen.getByRole("button", { name: "Newer" }) as HTMLButtonElement).disabled).toBe(false);
    // A short page is the server saying there is nothing older.
    expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    await waitFor(() => expect(screen.getByText("Page 1")).toBeDefined());
  });
});
