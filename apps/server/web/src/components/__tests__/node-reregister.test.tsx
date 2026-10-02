import { afterEach, expect, it } from "bun:test";
import { setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeReregister } from "@/components/nodes/node-reregister";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  setConfirmHandler(null);
  globalThis.fetch = originalFetch;
});

it("reveals a setup key with client instructions and retires it on a node switch", async () => {
  setConfirmHandler(() => Promise.resolve(true));
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ id: "k1", key: "nsk_recovery", expiresAt: "2030-01-01T00:00:00Z" }),
    )) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (nodeId: string) => (
    <QueryClientProvider client={client}>
      <NodeReregister nodeId={nodeId} nodeName={nodeId} canManage />
    </QueryClientProvider>
  );
  const { rerender } = render(tree("n1"));
  fireEvent.click(screen.getByRole("button", { name: "Re-register" }));
  expect(await screen.findByText(/This setup key is tied to n1/)).toBeDefined();
  expect(screen.getByText(/Service → Re-enroll/)).toBeDefined();
  rerender(tree("n2"));
  expect(screen.queryByText(/This setup key is tied to n1/)).toBeNull();
  expect(screen.getByRole("button", { name: "Re-register" })).toBeDefined();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("does not mint for a different node when confirmation finishes after navigation", async () => {
  const consent = deferred<boolean>();
  setConfirmHandler(() => consent.promise);
  let posts = 0;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "POST") posts++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new QueryClient();
  const tree = (nodeId: string) => (
    <QueryClientProvider client={client}>
      <NodeReregister nodeId={nodeId} nodeName={nodeId} canManage />
    </QueryClientProvider>
  );
  const { rerender } = render(tree("n1"));
  fireEvent.click(screen.getByRole("button", { name: "Re-register" }));
  rerender(tree("n2"));
  await act(async () => {
    consent.resolve(true);
  });
  expect(posts).toBe(0);
});

it("a late mint response cannot overwrite the next node's recovery key", async () => {
  setConfirmHandler(() => Promise.resolve(true));
  const oldReply = deferred<Response>();
  const posts: string[] = [];
  globalThis.fetch = (async (input: unknown, options?: RequestInit) => {
    const url = String(input);
    if (options?.method !== "POST") return Response.json({});
    posts.push(url);
    if (url.endsWith("/n1/reregister")) return oldReply.promise;
    return Response.json({ id: "new-key", key: "nsk_new_node", expiresAt: "2030-01-01T00:00:00Z" });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (nodeId: string) => (
    <QueryClientProvider client={client}>
      <NodeReregister nodeId={nodeId} nodeName={nodeId} canManage />
    </QueryClientProvider>
  );
  const { rerender } = render(tree("n1"));
  fireEvent.click(screen.getByRole("button", { name: "Re-register" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  rerender(tree("n2"));
  fireEvent.click(screen.getByRole("button", { name: "Re-register" }));
  expect(await screen.findByText("nsk_new_node")).toBeDefined();
  await act(async () => {
    oldReply.resolve(Response.json({ id: "old-key", key: "nsk_old_node", expiresAt: "2030-01-01T00:00:00Z" }));
  });
  expect(screen.getByText("nsk_new_node")).toBeDefined();
  expect(screen.queryByText("nsk_old_node")).toBeNull();
  expect(posts).toEqual(["/api/nodes/n1/reregister", "/api/nodes/n2/reregister"]);
});
