import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VirtualDisplayField, virtualDisplayReason } from "@/components/subshell-picker/virtual-display-field";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const linux = { id: "node1", name: "Test machine", os: "linux", previewEnabled: true, canManage: true } as Node;
const ready = { supported: true, missing: [] };
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}
function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("virtual display prerequisites", () => {
  it("requires Linux, enabled preview, and a completed machine check", () => {
    expect(virtualDisplayReason(linux, ready)).toBeUndefined();
    expect(virtualDisplayReason(linux)).toContain("Checking");
    expect(virtualDisplayReason({ ...linux, os: "darwin" })).toContain("Linux");
    expect(virtualDisplayReason({ ...linux, previewEnabled: false })).toContain("Allow preview");
    expect(virtualDisplayReason(null)).toContain("Choose a machine");
    expect(virtualDisplayReason(linux, { supported: true, missing: ["x11vnc"] })).toContain(
      "Install x11vnc on Test machine",
    );
  });
  it("disables a missing display, explains the remedy, and enables it after rechecking", async () => {
    respond({ supported: true, missing: ["Xvfb", "x11vnc"] });
    const changes: boolean[] = [];
    render(<VirtualDisplayField node={linux} id="display" checked={true} onChange={(value) => changes.push(value)} />, {
      wrapper,
    });
    await screen.findByText(/Install Xvfb, x11vnc on Test machine, then choose Recheck/);
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    expect(changes).toContain(false);
    respond(ready);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
  });
  it("fails closed when a check fails and recovers on recheck", async () => {
    respond({ message: "Bring this node online, then recheck." }, 409);
    render(<VirtualDisplayField node={linux} id="display" checked={false} onChange={() => {}} />, { wrapper });
    await screen.findByText(/Bring this node online/);
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    respond(ready);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
  });
  it("doesn't reuse another machine's successful check", async () => {
    respond(ready);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = { id: "display", checked: false, onChange: () => {} };
    const view = render(
      <QueryClientProvider client={client}>
        <VirtualDisplayField {...props} node={linux} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
    respond({ supported: true, missing: ["xauth"] });
    view.rerender(
      <QueryClientProvider client={client}>
        <VirtualDisplayField {...props} node={{ ...linux, id: "node2" }} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    await screen.findByText(/Install xauth/);
  });
});
