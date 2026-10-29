import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedServices } from "../saved-services";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
it("offers separate open and edit actions for a saved service", async () => {
  const service = {
    id: "svc",
    name: "Proxmox",
    host: "localhost",
    protocol: "https",
    port: 8006,
    ignoreCertificateErrors: true,
  };
  globalThis.fetch = (async () => Response.json([service])) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let edited: unknown;
  let opened: unknown;
  render(
    <QueryClientProvider client={client}>
      <SavedServices
        subshellId="pane"
        canEdit
        onAdd={() => {}}
        onEdit={(s) => {
          edited = s;
        }}
        onOpen={(s) => {
          opened = s;
        }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit Proxmox" }));
  expect(edited).toEqual(service);
  expect(opened).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /^Proxmox\s*https/ }));
  expect(opened).toEqual(service);
  client.clear();
});
