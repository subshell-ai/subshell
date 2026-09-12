import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
function mockFetch(answer: () => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/audit") return answer();
    throw new Error(`unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
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
