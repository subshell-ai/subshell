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
    expect(guide.getAttribute("href")).toBe("https://docs.subshell.sh/previews/setup");
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
  it("offers only the providers this machine's OS can run", async () => {
    // The stored policy is the owner's and can hold both, so the row filters by
    // the node's reported OS: Xvfb is Linux's display server, and offering it on
    // a Mac sends the person to a launch the machine refuses.
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response(JSON.stringify(ready));
    }) as typeof fetch;
    render(
      <VirtualDisplayField
        node={{
          ...linux,
          os: "darwin",
          virtualDisplayProviders: ["xvfb-x11vnc", "betterdisplay"],
          virtualDisplayProvider: "betterdisplay",
        }}
        provider="betterdisplay"
        onProviderChange={() => {}}
        id="display"
        checked
        onChange={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(paths.some((p) => p.endsWith("?provider=betterdisplay"))).toBe(true));
    fireEvent.click(screen.getByRole("combobox", { name: "Display provider" }));
    expect(await screen.findByRole("option", { name: "BetterDisplay" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Xvfb + VNC" }) === null).toBe(true);
  });
  it("does not echo a provider the machine cannot run back into the list", async () => {
    // The other direction of the same gate, and the one that used to leak: the
    // picker keeps the current pick listed even when the caller's filtered
    // array dropped it, so switching machines left BetterDisplay selected and
    // offered on a Linux node. A bundled id that is NOT in the OS list is the
    // gate speaking, not an unknown provider of the node's own, and it must not
    // come back as a choice the launch will be refused for.
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response(JSON.stringify(ready));
    }) as typeof fetch;
    render(
      <VirtualDisplayField
        node={{ ...linux, virtualDisplayProviders: ["xvfb-x11vnc", "betterdisplay"] }}
        provider="betterdisplay"
        onProviderChange={() => {}}
        id="display"
        checked
        onChange={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("combobox", { name: "Display provider" }));
    expect(await screen.findByRole("option", { name: "Xvfb + VNC" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "BetterDisplay" }) === null).toBe(true);
  });
  it("keeps naming a saved pick while the machine has not answered its OS", async () => {
    // The list and the value are one decision. An enrolled node that never
    // came ready reports no OS, which keeps a saved provider (clearing it
    // would cost the pick to a read that says nothing) - so the row has to
    // keep SHOWING it too. Filtering the list while keeping the value is how
    // the trigger came to read "Node default" over a BetterDisplay pin the
    // launch would honour, and the person approved a provider they never saw.
    respond(ready);
    render(
      <VirtualDisplayField
        node={{
          ...linux,
          os: null,
          virtualDisplayProviders: ["xvfb-x11vnc", "betterdisplay"],
          virtualDisplayProvider: "xvfb-x11vnc",
        }}
        provider="betterdisplay"
        onProviderChange={() => {}}
        id="display"
        checked
        onChange={() => {}}
      />,
      { wrapper },
    );
    const trigger = await screen.findByRole("combobox", { name: "Display provider" });
    expect(trigger.textContent).toContain("BetterDisplay");
    expect(trigger.textContent?.includes("Node default")).toBe(false);
    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "BetterDisplay" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Xvfb + VNC" })).toBeTruthy();
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

describe("launch refusals at the control", () => {
  const refusal =
    "That node's virtual display did not come up inside the launch budget, so the screen pane was refused. Try again, or launch without a screen. (preview-display-not-ready: display :90 / rfb 5910 not answering within 10000ms (Xvfb socket never appeared))";
  it("renders the refusal beside the checkbox and names it to assistive tech", async () => {
    respond(ready);
    render(<VirtualDisplayField node={linux} id="display" checked onChange={() => {}} launchError={refusal} />, {
      wrapper,
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("preview-display-not-ready");
    expect(alert.getAttribute("id")).toBe("display-launch-error");
    expect(screen.getByRole("checkbox").getAttribute("aria-describedby")).toContain("display-launch-error");
  });
  it("says nothing when no launch was refused", async () => {
    respond(ready);
    render(<VirtualDisplayField node={linux} id="display" checked onChange={() => {}} />, { wrapper });
    await waitFor(() => expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true"));
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect((screen.getByRole("checkbox").getAttribute("aria-describedby") ?? "").includes("launch-error")).toBe(false);
  });
});
