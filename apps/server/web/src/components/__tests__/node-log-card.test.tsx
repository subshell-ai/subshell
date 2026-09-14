import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NodeLogCard } from "@/components/nodes/node-log-card";
import type { NodeDetail } from "@/types/node";

let realFetch: typeof globalThis.fetch;
let reads = 0;

beforeEach(() => {
  reads = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/logs")) {
      reads += 1;
      return new Response(JSON.stringify({ text: "", nextByte: 0, size: 0, truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

const node = {
  id: "n1",
  name: "builder",
  runtime: { agentLogPath: "/c/agent.log", logging: { debug: false, source: "setting" } },
} as NodeDetail;

/** The same node, but with the switch taken away by that machine's environment. */
const forced = {
  id: "n1",
  name: "builder",
  runtime: { agentLogPath: "/c/agent.log", logging: { debug: true, source: "process env" } },
} as NodeDetail;

function renderCard(which: NodeDetail = node) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  // 20ms, not the production second: these tests assert that the interval
  // FIRES, and waiting a real second for it left a 4x margin that 34-way
  // parallel `turbo test` ate (measured 2026-09-14). The assertion is
  // unchanged; only the clock it waits on is honest about being a test.
  return render(<NodeLogCard node={which} pollMs={20} />, { wrapper: Wrapper });
}

describe("NodeLogCard", () => {
  it("follows on its own, and Pause stops the asking", async () => {
    renderCard();
    // It polls: a second ask arrives with nobody pressing anything.
    await waitFor(() => expect(reads).toBeGreaterThan(1), { timeout: 2_000 });

    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    const atPause = reads;
    await new Promise((settle) => setTimeout(settle, 2_500));
    // Paused means the REQUESTS stop — not a label drawn over a moving tail.
    // Asserted by counting reads rather than reading the button, which is the
    // only way to tell those two apart.
    expect(reads).toBe(atPause);

    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(reads).toBeGreaterThan(atPause), { timeout: 2_000 });
  }, 15_000);

  it("asks nothing while the tab is hidden", async () => {
    renderCard();
    await waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 2_000 });

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const atHide = reads;
    await new Promise((settle) => setTimeout(settle, 2_500));
    // This is a bare `setInterval`, not a TanStack query, so it does NOT get
    // `refetchIntervalInBackground: false` for free — and at one second it
    // would otherwise wake a remote agent behind a tab nobody is looking at.
    expect(reads).toBe(atHide);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(reads).toBeGreaterThan(atHide), { timeout: 2_000 });
  }, 15_000);

  it("offers the debug switch, and says it is read-only when the environment forces it", () => {
    renderCard();
    expect(screen.getByRole("switch", { name: "Debug logging" })).toBeTruthy();

    cleanup();
    renderCard(forced);
    // The environment wins everywhere else on this config ladder; a switch
    // that wrote a value the next read would mask reports a change that never
    // happens. The server's own card says the same thing the same way.
    expect(screen.queryByRole("switch", { name: "Debug logging" })).toBeNull();
    expect(screen.getByText(/SUBSHELL_DEBUG_LOGGING/)).toBeTruthy();
  });
});
