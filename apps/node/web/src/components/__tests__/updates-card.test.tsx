import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { UpdatesCard } from "../updates-card";

/**
 * The Updates page is the dashboard's one surface with no shared card behind
 * it, so it earns its own test. What matters is the WIRING and the HONESTY,
 * not the pixels:
 *
 * - it reads `/api/self/update` — the LOCAL endpoint, not the plane's
 *   `/api/nodes/:id/update` — because on this page the subject is this machine
 *   and there is no plane in the loop;
 * - an air-gapped node (`releaseConfigured: false`) gets the sentence naming
 *   the machine remedy, and is NOT offered an install button that would only
 *   fail.
 *
 * The daemon's act (install → exit → respawn) is out of scope here — the
 * reconnect overlay and the cli-e2e scenario cover the vanishing; this covers
 * the card deciding correctly what to show before anything is pressed.
 */
let requested: string[] = [];

function stubUpdateInfo(body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <UpdatesCard />
    </QueryClientProvider>,
  );
}

describe("UpdatesCard", () => {
  beforeEach(() => {
    requested = [];
  });
  afterEach(() => {
    cleanup();
  });

  test("reads the local /api/self/update and offers an install when a release source exists", async () => {
    stubUpdateInfo({
      currentVersion: "1.9.0",
      protocolVersion: 13,
      releaseConfigured: true,
      debugLogging: false,
      pending: null,
      lastFailure: null,
      connected: true,
    });
    renderCard();
    expect(await screen.findByText(/Running/)).toBeTruthy();
    expect(requested.some((u) => u.endsWith("/api/self/update"))).toBe(true);
    expect(screen.getByText("Update to latest")).toBeTruthy();
    // The force option must not promise a durable downgrade the page cannot
    // verify: a version the plane refuses lands HELD and is reverted on the
    // 4406 at the end of the hold, so the card says so beside the checkbox.
    expect(
      screen.getByText(
        "A downgrade the control plane will not accept is reversed automatically after about ten minutes offline.",
      ),
    ).toBeTruthy();
  });

  test("an air-gapped node is told the machine remedy and offered no install button", async () => {
    stubUpdateInfo({
      currentVersion: "1.9.0",
      protocolVersion: 13,
      releaseConfigured: false,
      debugLogging: false,
      pending: null,
      lastFailure: null,
      connected: false,
    });
    renderCard();
    expect(await screen.findByText(/air-gapped/)).toBeTruthy();
    expect(screen.queryByText("Update to latest")).toBeNull();
  });

  test("a pending update is stated as awaiting its boot-time confirmation", async () => {
    stubUpdateInfo({
      currentVersion: "1.9.0",
      protocolVersion: 13,
      releaseConfigured: true,
      debugLogging: false,
      pending: { from: "1.8.0", to: "1.9.0" },
      lastFailure: null,
      connected: true,
    });
    renderCard();
    expect(await screen.findByText(/not yet confirmed by a successful boot/)).toBeTruthy();
  });
});
