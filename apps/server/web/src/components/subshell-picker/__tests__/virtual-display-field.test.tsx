import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VirtualDisplayField } from "@/components/subshell-picker/virtual-display-field";

import { virtualDisplayReason } from "@/hooks/use-node-display-readiness";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const linux = { id: "node1", name: "Test machine", os: "linux", virtualDisplayEnabled: true, canManage: true } as Node;
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
  it("requires an enabled display and a completed provider check", () => {
    expect(virtualDisplayReason(linux, ready)).toBeUndefined();
    expect(virtualDisplayReason(linux)).toContain("Checking");
    expect(virtualDisplayReason({ ...linux, os: "darwin" }, { supported: false, missing: [] })).toContain(
      "does not support the selected node",
    );
    expect(virtualDisplayReason({ ...linux, virtualDisplayEnabled: false })).toContain("Allow virtual displays");
    expect(virtualDisplayReason(null)).toContain("Choose a node");
    expect(virtualDisplayReason(linux, { supported: true, missing: ["x11vnc"] })).toContain(
      "Virtual display requirements are missing",
    );
  });
  it("disables a missing display, explains the remedy, and enables it after rechecking", async () => {
    respond({ supported: true, missing: ["Xvfb", "x11vnc"] });
    const changes: boolean[] = [];
    render(
      <VirtualDisplayField node={linux} id="display" checked={false} onChange={(value) => changes.push(value)} />,
      {
        wrapper,
      },
    );
    const guide = await screen.findByRole("link", { name: "Set up virtual display" });
    expect(guide.getAttribute("href")).toBe("https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux");
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(guide.closest(".text-warning")).not.toBeNull();
    expect(screen.queryByText(/install Xvfb/)).toBeNull();
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    expect(changes).toEqual([]);
    respond(ready);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
    expect(screen.queryByRole("button", { name: "Recheck" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up virtual display" })).toBeNull();
  });
  it("preserves an unavailable preset display and lets the user opt out", async () => {
    respond({ supported: true, missing: ["Xvfb"] });
    const changes: boolean[] = [];
    render(<VirtualDisplayField node={linux} id="display" checked onChange={(v) => changes.push(v)} />, { wrapper });
    await screen.findByRole("link", { name: "Set up virtual display" });
    expect(changes).toEqual([]);
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(changes).toEqual([false]);
  });
  it("offers multiple enabled providers and checks the selected provider", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response(JSON.stringify(ready));
    }) as typeof fetch;
    const changes: (string | undefined)[] = [];
    render(
      <VirtualDisplayField
        node={{ ...linux, virtualDisplayProviders: ["xvfb-x11vnc", "native-example"] }}
        provider="native-example"
        onProviderChange={(p) => changes.push(p)}
        id="display"
        checked
        onChange={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(paths.some((p) => p.endsWith("?provider=native-example"))).toBe(true));
    fireEvent.click(screen.getByRole("combobox", { name: "Display provider" }));
    const option = await screen.findByRole("option", { name: "Xvfb + VNC" });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    expect(changes).toEqual(["xvfb-x11vnc"]);
    expect(virtualDisplayReason({ ...linux, virtualDisplayProviders: [] }, ready, "xvfb-x11vnc")).toContain("disabled");
  });
  it("fails closed when a check fails and recovers on recheck", async () => {
    respond({ message: "Bring this node online, then recheck." }, 409);
    render(<VirtualDisplayField node={linux} id="display" checked={false} onChange={() => {}} />, { wrapper });
    await screen.findByText(/Bring this node online/);
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    respond(ready);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
    expect(screen.queryByRole("button", { name: "Recheck" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up virtual display" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Recheck" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up virtual display" })).toBeNull();
    respond({ supported: true, missing: ["xauth"] });
    view.rerender(
      <QueryClientProvider client={client}>
        <VirtualDisplayField {...props} node={{ ...linux, id: "node2" }} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    await screen.findByRole("link", { name: "Set up virtual display" });
  });
});

it("preserves a selected display while revalidating the same machine", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["preview-display-readiness", linux.id, "xvfb-x11vnc"], ready);
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((r) => {
      resolve = r;
    })) as unknown as typeof fetch;
  const changes: boolean[] = [];
  render(
    <QueryClientProvider client={client}>
      <VirtualDisplayField node={linux} id="display" checked onChange={(v) => changes.push(v)} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(resolve).toBeDefined());
  expect(changes).toEqual([]);
  await act(async () => resolve(new Response(JSON.stringify(ready))));
  await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
  expect(changes).toEqual([]);
});
