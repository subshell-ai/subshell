import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { VersionStamp } from "@/components/version-stamp";

beforeAll(() => {
  // `__BUILD_ID__` is a Vite `define` — the real build substitutes it at
  // compile time, so under bun test the global simply is not there. It is
  // already TYPED as a bare const (src/vite-env.d.ts), hence the cast: this
  // supplies the VALUE the bundler would have inlined, not a second decl.
  (globalThis as unknown as Record<string, string>).__BUILD_ID__ = "2026-09-04 12:30";
});

/** Serves one body for GET /api/settings/public; `null` never resolves. */
function mockSettings(body: Record<string, unknown> | null) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/settings/public") {
      if (body === null) return new Promise<Response>(() => {}); // in flight forever
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function renderStamp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VersionStamp />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("VersionStamp", () => {
  it("shows the server version from the shared public-settings payload", async () => {
    const restore = mockSettings({ serverVersion: "1.5.0", allowRegistrations: true });
    try {
      renderStamp();
      await waitFor(() => expect(screen.getByText("1.5.0")).toBeDefined());
      expect(screen.getByText("Server")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("shows the bundle build id, which does NOT come from the server", async () => {
    // The two halves version independently — that is the whole reason both
    // are printed. This one is baked at compile time and is the only signal
    // that a sticky app cache is serving pre-fix JavaScript.
    const restore = mockSettings({ serverVersion: "1.5.0" });
    try {
      renderStamp();
      await waitFor(() => expect(screen.getByText("2026-09-04 12:30")).toBeDefined());
    } finally {
      restore();
    }
  });

  it("renders an em-dash, not a crash or a blank, while the query is in flight", () => {
    const restore = mockSettings(null);
    try {
      renderStamp();
      expect(screen.getByText("—")).toBeDefined();
      // The build id needs no network, so it must show immediately.
      expect(screen.getByText("2026-09-04 12:30")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("survives a payload with no serverVersion (an older server)", async () => {
    const restore = mockSettings({ allowRegistrations: true });
    try {
      renderStamp();
      await waitFor(() => expect(screen.getByText("—")).toBeDefined());
    } finally {
      restore();
    }
  });
});
