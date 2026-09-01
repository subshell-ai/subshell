import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Stubs the setup-key create endpoint (sharing-dialog.test's fetch-mock shape). */
function mockFetch() {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "POST" && url.pathname === "/api/nodes/setup-keys") {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "k1", key: "nsk_secret", expiresAt: "2026-09-01T00:00:00Z" }), {
          status: 201,
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderDialog(nodeCount = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddNodeDialog open onOpenChange={() => {}} nodeCount={nodeCount} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("AddNodeDialog", () => {
  it("step 1 → create POSTs the label", async () => {
    const { calls, restore } = mockFetch();
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await waitFor(() => {
        const post = calls.find((c) => c.method === "POST" && c.url === "/api/nodes/setup-keys");
        expect(post).toBeDefined();
        expect(JSON.parse(post?.body ?? "{}")).toEqual({ label: "mac mini" });
      });
    } finally {
      restore();
    }
  });

  it("step 2 shows the plaintext key once with the rendered install command", async () => {
    const { restore } = mockFetch();
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(await screen.findByText("nsk_secret")).toBeDefined();
      expect(screen.getByText('curl -fsSL "http://localhost/install.sh?setup_key=nsk_secret" | bash')).toBeDefined();
      expect(screen.getByText(/only time the full key is shown/i)).toBeDefined();
      expect(screen.getByText(/Waiting for enrollment/i)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("flips to the enrolled hint when the node count rose past the baseline", async () => {
    const { restore } = mockFetch();
    try {
      // Baseline is captured from the count at creation; re-render with a
      // higher count and the waiting hint becomes the success line.
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(
        <QueryClientProvider client={client}>
          <AddNodeDialog open onOpenChange={() => {}} nodeCount={1} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      await screen.findByText("nsk_secret");
      view.rerender(
        <QueryClientProvider client={client}>
          <AddNodeDialog open onOpenChange={() => {}} nodeCount={2} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/Node enrolled/i)).toBeDefined();
    } finally {
      restore();
    }
  });
});
