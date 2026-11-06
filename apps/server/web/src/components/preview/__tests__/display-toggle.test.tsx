/**
 * The picker's Virtual display row (spec 2026-11-06): the on/off flip rides
 * PUT/DELETE /:id/screen, always through the confirmation prompt, and the
 * caches that render the row's truth are invalidated after it. The prompt is
 * driven through the real ConfirmProvider dialog, as the plugins route test
 * does - no seam on `confirmAction`.
 */
import { afterEach, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { DisplayToggle } from "../display-toggle";

const offInfo: PreviewInfo = { nodeEnabled: true, ports: [], cdpPort: null, screen: null };
const onInfo: PreviewInfo = {
  ...offInfo,
  screen: { display: ":91", viewer: { protocol: "vnc", port: 5910 } },
};
const subshell = { id: "s-1", name: "worker", nodeId: "n-1", access: "owner", status: "running", alive: 1 };
const nodeFixture = {
  id: "n-1",
  name: "box",
  os: "linux",
  virtualDisplayEnabled: true,
  canManage: true,
} as Node;

interface ScreenCall {
  url: string;
  method?: string;
  body?: string;
}

/** Every path the last render fetched, so a test can wait for the reads to settle. */
let seenPaths: string[] = [];

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** Renders the row over `info` and records every call to its own `/screen` path. */
function renderToggle(info: PreviewInfo, access: "owner" | "view" = "owner", node: Node = nodeFixture): ScreenCall[] {
  const calls: ScreenCall[] = [];
  seenPaths = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seenPaths.push(url);
    if (url.includes("/screen")) {
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      return Response.json({ ok: true });
    }
    if (url.includes("display-readiness")) return Response.json({ supported: true, missing: [] });
    if (url.includes("/api/nodes")) return Response.json({ nodes: [node] });
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactElement = (
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <DisplayToggle subshellId="s-1" subshell={{ ...subshell, access }} info={info} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
  // A memory router because the row's own field renders "Open node settings"
  // (a Link) exactly when the node's display switch is off.
  const rootRoute = createRootRoute({ component: () => tree });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(<RouterProvider router={router} />);
  return calls;
}

/**
 * The checkbox once the node read and the readiness check have both landed.
 * Re-queried each poll on purpose: while a reason is on screen the tooltip
 * wrapper holds the checkbox, and clearing it re-mounts a different node.
 */
async function readyControl() {
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Virtual display" }).getAttribute("aria-disabled")).not.toBe("true"),
  );
  return screen.getByRole("checkbox", { name: "Virtual display" });
}

/** The exit transition leaves the prompt mounted briefly, so poll by boolean. */
async function expectNoDialog() {
  await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
}

it("asks before enabling, sends nothing on Cancel, and PUTs the default size on confirm", async () => {
  const calls = renderToggle(offInfo);
  const control = await readyControl();
  expect(control.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(control);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Enable virtual display?")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await expectNoDialog();
  expect(calls.length).toBe(0);
  // Reopen: the same click asks again, and confirming rides the PUT with the
  // launch form's default size and no provider (the node default answers).
  fireEvent.click(control);
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("button", { name: "Enable display" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]?.url).toBe("/api/subshells/s-1/screen");
  expect(calls[0]?.method).toBe("PUT");
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ width: 1280, height: 800 });
});

it("flips a running display off through its own confirm, with a DELETE", async () => {
  const calls = renderToggle(onInfo);
  const control = await readyControl();
  expect(control.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(control);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Turn off virtual display?")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Turn off display" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]?.url).toBe("/api/subshells/s-1/screen");
  expect(calls[0]?.method).toBe("DELETE");
});

it("explains the access limit to a view-only viewer instead of flipping", async () => {
  renderToggle(offInfo, "view");
  // find, not get: the router provider paints its tree asynchronously.
  expect((await screen.findByRole("checkbox", { name: "Virtual display" })).getAttribute("aria-disabled")).toBe("true");
  const blocker = await screen.findByRole("button", { name: /edit access/i });
  expect(blocker.getAttribute("aria-disabled")).toBe("true");
  // The limit holds once the machine answers (the box would otherwise be
  // live: the node itself can serve a display).
  await waitFor(() => expect(seenPaths.some((p) => p.includes("display-readiness"))).toBe(true));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Virtual display" }).getAttribute("aria-disabled")).toBe("true"),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Virtual display" }));
  expect(screen.queryAllByRole("dialog").length).toBe(0);
});

it("shows the node's own reason when its display switch is off, and clicks send nothing", async () => {
  const calls = renderToggle(offInfo, "owner", { ...nodeFixture, virtualDisplayEnabled: false });
  await screen.findByText(/Allow virtual displays/);
  expect(screen.getByRole("link", { name: "Open node settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Virtual display" }));
  expect(screen.queryAllByRole("dialog").length).toBe(0);
  await waitFor(() => expect(calls.length).toBe(0));
});
