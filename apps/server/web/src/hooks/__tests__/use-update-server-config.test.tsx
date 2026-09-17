import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useUpdateServerConfig } from "@/hooks/use-server-deployment";

/**
 * A Service-page save can change `TRUSTED_ORIGINS`, and the EFFECTIVE
 * allowlist — `GET /api/settings/public → trustedOrigins` — includes it.
 * The mobile dialog reads that field; left uninvalidated it showed a list
 * up to 30 s stale after a hand edit. Asserted as a refetch on the wire.
 */
const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function mockFetch() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/settings/public")
      return Promise.resolve(json({ viewerIsAdmin: true, trustedOrigins: [] }));
    if (url.pathname === "/api/admin/server/config")
      return Promise.resolve(json({ ...deploymentView(), warnings: [] }));
    return Promise.resolve(json({}));
  }) as typeof fetch;
  return calls;
}

describe("useUpdateServerConfig", () => {
  it("refreshes the public settings after a save, whose trustedOrigins the mobile dialog reads", async () => {
    const calls = mockFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const publicFetches = () => calls.filter((c) => c === "GET /api/settings/public").length;
    const { result } = renderHook(() => ({ settings: usePublicSettings(), update: useUpdateServerConfig() }), {
      wrapper,
    });
    await waitFor(() => expect(publicFetches()).toBe(1));
    act(() => result.current.update.mutate({ trustedOrigins: ["http://box.local:3080"] }));
    await waitFor(() => expect(publicFetches()).toBe(2));
  });
});
