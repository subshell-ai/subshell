import { afterEach, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeCrossAgentCard } from "@/components/nodes/node-cross-agent-card";

function node(over: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.0.0",
    protocolVersion: 12,
    access: "owner",
    canManage: true,
    canRetire: true,
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
    sshWideForwards: false,
    held: null,
    ...over,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function mount(n: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeCrossAgentCard node={n} />
    </QueryClientProvider>,
  );
}
it("saves notes and suggested directories without changing directory permissions", async () => {
  const writes: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url, init) => {
    writes.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{"ok":true}');
  }) as unknown as typeof fetch;
  mount(node({ crossCommNotes: "Existing notes", recommendedStartingDirs: ["/work"] }));
  expect((screen.getByLabelText("Notes for calling agents") as HTMLTextAreaElement).value).toBe("Existing notes");
  fireEvent.change(screen.getByLabelText("Notes for calling agents"), { target: { value: "GPU available" } });
  fireEvent.click(screen.getByRole("button", { name: "Add directory" }));
  fireEvent.change(screen.getByLabelText("Directory"), { target: { value: "/data" } });
  fireEvent.click(screen.getByRole("button", { name: "Add directory" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        url: "/api/nodes/node1/cross-agent",
        body: { crossCommNotes: "GPU available", recommendedStartingDirs: ["/work", "/data"] },
      },
    ]),
  );
});
it("keeps guidance read-only for shared viewers and explains ownership", () => {
  mount(node({ canManage: false, access: "edit" }));
  expect((screen.getByLabelText("Notes for calling agents") as HTMLTextAreaElement).readOnly).toBe(true);
  expect(screen.getByRole("button", { name: "Save guidance" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Only the node owner can edit this guidance.")).toBeTruthy();
});
it("rejects relative suggestions and retains edits after a failed save", async () => {
  globalThis.fetch = (async () =>
    new Response('{"message":"Could not save"}', { status: 500 })) as unknown as typeof fetch;
  mount(node());
  fireEvent.click(screen.getByRole("button", { name: "Add directory" }));
  fireEvent.change(screen.getByLabelText("Directory"), { target: { value: "relative" } });
  expect(screen.getByRole("button", { name: "Add directory" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.change(screen.getByLabelText("Directory"), { target: { value: "/project" } });
  fireEvent.click(screen.getByRole("button", { name: "Add directory" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Directory") as HTMLTextAreaElement).value).toBe("/project");
});
it("removes a recommendation immediately without changing the remaining guidance", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    writes.push(JSON.parse(String(init?.body)));
    return new Response('{"ok":true}');
  }) as unknown as typeof fetch;
  mount(node({ crossCommNotes: "Use this node for builds", recommendedStartingDirs: ["/work", "/data"] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove /work" }));
  await waitFor(() =>
    expect(writes).toEqual([{ crossCommNotes: "Use this node for builds", recommendedStartingDirs: ["/data"] }]),
  );
});
