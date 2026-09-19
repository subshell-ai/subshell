import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeKeyRotate } from "@/components/nodes/node-key-rotate";
import { setConfirmHandler } from "@/lib/confirm";

/**
 * Regression pin for the plaintext-once guarantee across a node switch:
 * TanStack reuses route components across param changes (same hazard the
 * repo notes in routes/presets_.$id), so a rerender with a new `nodeId` —
 * no unmount — must still retire the previous node's revealed key. With an
 * empty-deps reset effect this fails: the old plaintext rides along.
 */
function mockRotateFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST" && url.pathname.endsWith("/rotate-key")) {
      const id = url.pathname.split("/")[3]; // /api/nodes/<id>/rotate-key
      return Promise.resolve(
        new Response(JSON.stringify({ nodeKey: `subshell_key_${id}`, message: "re-config by hand" })),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tree = (nodeId: string) => (
  <QueryClientProvider client={client}>
    <NodeKeyRotate nodeId={nodeId} nodeName={nodeId} canManage />
  </QueryClientProvider>
);

afterEach(() => {
  cleanup();
  setConfirmHandler(null);
});

describe("NodeKeyRotate plaintext lifetime", () => {
  it("retires the revealed key when the nodeId prop changes (route-component reuse)", async () => {
    setConfirmHandler(() => Promise.resolve(true));
    const { restore } = mockRotateFetch();
    try {
      const { rerender } = render(tree("node1"));
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      await waitFor(() => expect(screen.getByText("subshell_key_node1").textContent).toBe("subshell_key_node1"));

      // Simulate the param change a node switch produces WITHOUT a remount.
      rerender(tree("agent2"));
      expect(screen.queryByText("subshell_key_node1")).toBeNull();
      // The new node starts clean — no reveal card, just the button.
      expect(screen.getByRole("button", { name: /Rotate key/ })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("keeps the key revealed for the same node across an unrelated rerender", async () => {
    setConfirmHandler(() => Promise.resolve(true));
    const { restore } = mockRotateFetch();
    try {
      const { rerender } = render(tree("node1"));
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      await waitFor(() => expect(screen.getByText("subshell_key_node1").textContent).toBe("subshell_key_node1"));

      rerender(tree("node1"));
      expect(screen.getByText("subshell_key_node1").textContent).toBe("subshell_key_node1");
    } finally {
      restore();
    }
  });
});
