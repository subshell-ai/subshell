import { afterEach, describe, expect, it } from "bun:test";
import { setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeKeyRotate } from "@/components/nodes/node-key-rotate";

/**
 * Regression pin for the plaintext-once guarantee across a node switch:
 * TanStack reuses route components across param changes (same hazard the
 * repo notes in routes/presets_.$id), so a rerender with a new `nodeId` —
 * no unmount — must still retire the previous node's revealed key. With an
 * empty-deps reset effect this fails: the old plaintext rides along.
 *
 * The rest of the file pins the CARD that replaced the bare button: the two
 * install paths, and the fact that the CLI path names the command the node CLI
 * actually grew (`configure --key`), rather than the fictional `subshell
 * config` this screen used to point at.
 */
function mockRotateFetch(message = "New key active, install it with subshell configure --key.") {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST" && url.pathname.endsWith("/rotate-key")) {
      const id = url.pathname.split("/")[3]; // /api/nodes/<id>/rotate-key
      return Promise.resolve(new Response(JSON.stringify({ nodeKey: `subshell_key_${id}`, message })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tree = (nodeId: string, agentVersion: string | null = "0.16.0") => (
  <QueryClientProvider client={client}>
    <NodeKeyRotate nodeId={nodeId} nodeName={nodeId} agentVersion={agentVersion} canManage />
  </QueryClientProvider>
);

afterEach(() => {
  cleanup();
  setConfirmHandler(null);
});

async function reveal(nodeId = "node1", agentVersion: string | null = "0.16.0") {
  setConfirmHandler(() => Promise.resolve(true));
  const { rerender } = render(tree(nodeId, agentVersion));
  fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
  await waitFor(() => expect(screen.getByText(`subshell_key_${nodeId}`).textContent).toBe(`subshell_key_${nodeId}`));
  return { rerender };
}

describe("NodeKeyRotate plaintext lifetime", () => {
  it("retires the revealed key when the nodeId prop changes (route-component reuse)", async () => {
    setConfirmHandler(() => Promise.resolve(true));
    const { restore } = mockRotateFetch();
    try {
      const { rerender } = render(tree("node1"));
      fireEvent.click(await screen.findByRole("button", { name: /Rotate key/ }));
      await waitFor(() => expect(screen.getByText("subshell_key_node1").textContent).toBe("subshell_key_node1"));

      // Simulate the param change a node switch produces WITHOUT a remount.
      rerender(tree("node2"));
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

describe("NodeKeyRotate install instructions", () => {
  it("opens on the CLI tab, whose command is the one the node CLI grew", async () => {
    const { restore } = mockRotateFetch();
    try {
      await reveal();
      // The command carries the key INSIDE it and is copyable whole, so the
      // operator never re-types a 40-character bearer token.
      expect(screen.getByText(/subshell configure --key "subshell_key_node1"/)).toBeDefined();
      expect(screen.getByText("subshell service restart")).toBeDefined();
      // No by-hand version warning on a node new enough for the flag.
      expect(screen.queryByText(/needs node version/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("the Client App tab says the app takes NO node key, pointing back at the CLI", async () => {
    const { restore } = mockRotateFetch();
    try {
      await reveal();
      fireEvent.click(screen.getByRole("button", { name: "Client App" }));
      expect(screen.getByText(/has no field for a node key/)).toBeDefined();
      // The point of naming the setup key here: Re-enroll spends a SETUP key
      // and mints a SECOND node, which is the wrong act for a rotation.
      expect(screen.getByText(/registers a new node/)).toBeDefined();
      // The two commands were the CLI tab's, so they are gone from this one.
      expect(screen.queryByText(/subshell configure --key/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("warns the command is too new only when the node reports an older version", async () => {
    const { restore } = mockRotateFetch();
    try {
      // 0.14.x predates the cut that carries `configure --key` (0.15.0, the
      // same release as unenroll/autostart); 0.15.0 itself is the threshold
      // and `semverLt` is strict, so only a genuinely older report warns.
      await reveal("node1", "0.14.3");
      expect(screen.getByText(/needs node version 0\.15\.0/)).toBeDefined();
      expect(screen.getByText(/config\.json/)).toBeDefined();
      // The new-enough case, asserted alongside so a flipped comparison or a
      // drifted constant fails here rather than silently hiding the warning.
      cleanup();
      await reveal("node1", "0.15.0");
      expect(screen.queryByText(/needs node version/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays silent about a version it was never told", async () => {
    const { restore } = mockRotateFetch();
    try {
      // null = never checked in. No warning (it may be new), and no claiming
      // the node is old enough either — the commands just show.
      await reveal("node1", null);
      expect(screen.getByText(/subshell configure --key/)).toBeDefined();
      expect(screen.queryByText(/needs node version/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("forgets the key on Done", async () => {
    const { restore } = mockRotateFetch();
    try {
      await reveal();
      fireEvent.click(screen.getByRole("button", { name: "Done, hide the key" }));
      expect(screen.queryByText("subshell_key_node1")).toBeNull();
    } finally {
      restore();
    }
  });
});
