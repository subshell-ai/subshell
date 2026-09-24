import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LockdownBanner } from "@/components/lockdown-banner";

/**
 * The server-wide lockdown banner (operator ask 2026-09-24): every signed-in
 * person must learn the instance is stopped without opening a page that
 * refuses them. Same discipline as `EmergencyLoginBanner`: non-dismissible
 * (the remedy is server-side), driven by the shared public-settings read, and
 * an ABSENT flag (an older server) must render nothing rather than flash.
 */

function mockPublic(lockdown: boolean | undefined) {
  const original = globalThis.fetch;
  const payload: Record<string, unknown> = {
    allowRegistrations: false,
    allowNodeEnrollment: true,
    allowServerSubshells: true,
    instanceName: "test",
    emergencyLoginActive: false,
    appBaseUrl: "http://localhost:3080",
    trustedOrigins: [],
    viewerIsAdmin: false,
    serverVersion: "1.6.0",
    nodeArtifactTargets: [],
    nodeArtifactsAutoFetch: true,
  };
  if (lockdown !== undefined) payload.lockdown = lockdown;
  globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload)))) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LockdownBanner />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("the lockdown banner", () => {
  it("shows while the flag is on, and names what it means", async () => {
    const m = mockPublic(true);
    try {
      renderBanner();
      expect(await screen.findByText(/lockdown/i)).toBeTruthy();
      expect(screen.getByText(/cannot be created|no new subshells/i)).toBeTruthy();
    } finally {
      m.restore();
    }
  });

  it("renders nothing when the flag is off or unknown", async () => {
    for (const flag of [false, undefined]) {
      const m = mockPublic(flag);
      try {
        const { container } = renderBanner();
        // Review finding I-3: `waitFor` runs its callback SYNCHRONOUSLY on
        // entry, so the old assertion passed on the pre-data DOM and could
        // never fail for the case it named. Flush the query to settled on
        // purpose, THEN assert the silence is real.
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        expect(container.textContent).toBe("");
      } finally {
        m.restore();
      }
    }
  });
});
