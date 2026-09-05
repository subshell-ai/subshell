import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * Stubs the setup-key create endpoint (sharing-dialog.test's fetch-mock
 * shape). `publicSettings` is the body served for GET /api/settings/public —
 * `{}` means "loaded but shape-missing", exercising the origin fallback.
 */
function mockFetch(publicSettings?: Record<string, unknown>) {
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
    if (method === "GET" && url.pathname === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify(publicSettings ?? {}), { status: 200 }));
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

  it("bakes the SERVER's appBaseUrl into the install command, not the browser origin", async () => {
    const { restore } = mockFetch({ appBaseUrl: "http://100.71.37.94:3080" });
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(
        await screen.findByText('curl -fsSL "http://100.71.37.94:3080/install.sh?setup_key=nsk_secret" | bash'),
      ).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("warns in amber when appBaseUrl points at loopback (a remote node would dial itself)", async () => {
    const { restore } = mockFetch({ appBaseUrl: "http://localhost:3080" });
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      const hint = await screen.findByText(/points at loopback/i);
      expect(hint.textContent).toContain("http://localhost:3080");
      expect(hint.textContent).toContain("VPN/LAN");
    } finally {
      restore();
    }
  });

  it("treats an unparseable appBaseUrl as not-loopback (no hint, no throw in render)", async () => {
    const { restore } = mockFetch({ appBaseUrl: "not a url" });
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(await screen.findByText("nsk_secret")).toBeDefined();
      expect(screen.queryByText(/points at loopback/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it("warns and offers the enroll fallback when the server publishes no agent binaries", async () => {
    // The fresh binary-only-install bug: install.sh would 404 the download,
    // so the dialog must say so and hand over the manual enroll command.
    const { restore } = mockFetch({ appBaseUrl: "https://subshell.example", nodeArtifactTargets: [] });
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      expect(await screen.findByText(/no agent binary published/i)).toBeDefined();
      expect(screen.getByText('subshell enroll --server "https://subshell.example" --key "nsk_secret"')).toBeDefined();
      // The one-liner stays visible — it still works once artifacts exist.
      expect(screen.getByText(/install\.sh\?setup_key=nsk_secret/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("names only the MISSING targets when artifacts are published for some", async () => {
    const { restore } = mockFetch({
      appBaseUrl: "https://subshell.example",
      nodeArtifactTargets: ["linux-x64", "linux-arm64", "darwin-arm64"],
    });
    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
      fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
      const hint = await screen.findByText(/no agent binary published/i);
      expect(hint.textContent).toContain("darwin-x64");
      expect(hint.textContent).not.toContain("linux-x64");
    } finally {
      restore();
    }
  });

  it("stays silent when all targets are published — and when the server predates the field", async () => {
    // `{}` above (the default mock) is the pre-field server shape: a cached
    // PWA against an older backend must not nag about a field it can't see.
    for (const settings of [
      {
        appBaseUrl: "https://subshell.example",
        nodeArtifactTargets: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
      },
      {},
    ]) {
      const { restore } = mockFetch(settings);
      try {
        renderDialog();
        fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "mac mini" } });
        fireEvent.click(screen.getByRole("button", { name: "Create setup key" }));
        await screen.findByText("nsk_secret");
        expect(screen.queryByText(/no agent binary published/i)).toBeNull();
      } finally {
        restore();
      }
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
