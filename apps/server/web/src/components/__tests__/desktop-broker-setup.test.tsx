import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DESKTOP_BROKERS_QUERY_KEY, DesktopBrokerSetup } from "@/components/connect/desktop-broker-setup";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

it("names a paired computer, clears its code when online, and revokes access", async () => {
  const requests: { method: string; body?: string }[] = [];
  let brokers: { id: string; name: string; online: boolean }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, body: init?.body as string | undefined });
    const data =
      method === "POST"
        ? {
            id: "desktop:d1",
            name: "Travel laptop",
            pairingToken: "secret-pair-code",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : method === "DELETE"
          ? { ok: true }
          : { brokers };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DesktopBrokerSetup />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Computer name (optional)"), { target: { value: "Travel laptop" } });
  fireEvent.click(screen.getByRole("button", { name: "Add computer" }));
  await screen.findByText("secret-pair-code");
  expect(JSON.parse(requests.find((request) => request.method === "POST")?.body ?? "{}").name).toBe("Travel laptop");
  expect(screen.getByRole("button", { name: "Copy pairing code" })).toBeTruthy();
  brokers = [{ id: "desktop:d1", name: "Travel laptop", online: true }];
  await act(async () => {
    await client.invalidateQueries({ queryKey: DESKTOP_BROKERS_QUERY_KEY });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await waitFor(() => expect(screen.queryByText("secret-pair-code")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await waitFor(() => expect(requests.some((request) => request.method === "DELETE")).toBe(true));
  client.clear();
});
