import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeSharingDialog } from "../node-sharing-dialog";

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

/** Stub the node shares GET/PUT and the roster, recording writes for assertions. */
function mockNodeShares(initial: { granteeUserId: string | null; permission: string }[]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (url.pathname === "/api/nodes/n/shares" && method === "GET") {
      return Promise.resolve(
        Response.json({
          shares: initial.map((s, i) => ({
            id: `r${i}`,
            granteeUserId: s.granteeUserId,
            granteeName: s.granteeUserId === null ? "Everyone" : s.granteeUserId,
            permission: s.permission,
          })),
        }),
      );
    }
    if (url.pathname === "/api/users") {
      return Promise.resolve(
        Response.json({ viewerIsAdmin: true, users: [{ id: "u2", email: "bob@subshell.local", name: "Bob" }] }),
      );
    }
    return Promise.resolve(Response.json({ shares: [] }));
  }) as typeof fetch;
  return { calls };
}

function renderDialog(canManage = true) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cache}>
      <NodeSharingDialog nodeId="n" kind="agent" open onOpenChange={() => {}} canManage={canManage} />
    </QueryClientProvider>,
  );
}

it("offers Manage and saves the Manage grantee in the PUT (spec 2026-11-07)", async () => {
  const { calls } = mockNodeShares([]);
  renderDialog();
  await screen.findByText("Not shared with anyone yet.");
  fireEvent.click(screen.getByRole("combobox", { name: "Access level to grant" }));
  const manageOption = await screen.findByRole("option", { name: "Manage" });
  // The whole three-rung ladder is on offer: nodes gained the top assignable rung.
  expect(screen.getByRole("option", { name: "View" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "View + edit" })).toBeTruthy();
  fireEvent.pointerDown(manageOption);
  fireEvent.pointerUp(manageOption);
  fireEvent.click(manageOption);

  const picker = screen.getByRole("combobox", { name: "Share with" });
  fireEvent.mouseDown(picker);
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: "bob" } });
  fireEvent.click(await screen.findByRole("option", { name: "bob@subshell.local" }));
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByText("bob@subshell.local");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/shares"));
    const body = JSON.parse(put?.body ?? "{}") as { shares: { granteeUserId: string | null; permission: string }[] };
    expect(body.shares).toEqual([{ granteeUserId: "u2", permission: "manage" }]);
  });
});

it("offers no Manage rung on the server host: the server refuses those grants", async () => {
  // `manage` on `local` is a 400 at the route (spec 2026-11-07: the
  // control-plane host has exactly one manager, the admin seat), so the
  // picker must not dangle a level the save would always reject.
  const { calls } = mockNodeShares([]);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <NodeSharingDialog nodeId="local" kind="local" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByText("Not shared with anyone yet.");
  fireEvent.click(screen.getByRole("combobox", { name: "Access level to grant" }));
  expect(await screen.findByRole("option", { name: "View + edit" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Manage" }) === null).toBe(true);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

it("names the Manage level to a read-only viewer", async () => {
  // The read-only rows render from the offered levels, so a manage grant
  // never degrades into a blank or "View" cell for someone who cannot edit.
  mockNodeShares([{ granteeUserId: "u2", permission: "manage" }]);
  renderDialog(false);
  expect(await screen.findByText("Manage")).toBeTruthy();
  expect(screen.queryByRole("combobox") === null).toBe(true);
});
it("warns at the decision point that Manage on Everyone arms every account", async () => {
  // Operator ruling 2026-11-07: the route ALLOWS a manage grant on the
  // Everyone row of an agent node, so the dialog is the only place the
  // consequence can be said. If the sentence is dropped, the widest grant
  // on the ladder goes out undocumented.
  mockNodeShares([]);
  renderDialog();
  expect(await screen.findByText(/Manage on Everyone gives it to every signed-in account/)).toBeTruthy();
});

it("says nothing about Everyone Manage on the server host", async () => {
  // `local` refuses manage grants at the route, so the caution names a
  // grant that can never be saved there.
  mockNodeShares([]);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <NodeSharingDialog nodeId="local" kind="local" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByText("Not shared with anyone yet.");
  expect(screen.queryByText(/Manage on Everyone/) === null).toBe(true);
});

it("refuses edits after a failed grant read and recovers the existing grants on retry", async () => {
  let failed = true;
  let writes = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes++;
      return Response.json({ shares: [] });
    }
    if (String(input).endsWith("/shares")) {
      return failed
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({
            shares: [{ id: "s", granteeUserId: null, granteeName: "Everyone", permission: "view" }],
          });
    }
    return Response.json({ users: [] });
  }) as typeof fetch;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <NodeSharingDialog nodeId="n" kind="agent" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByText("Couldn't load sharing settings. Try again before making changes.");
  expect(screen.queryByRole("button", { name: "Add" }) === null).toBe(true);
  expect(screen.getByRole("button", { name: "Save" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(screen.queryByText("Not shared with anyone yet.") === null).toBe(true);
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Remove access for Everyone" });
  await waitFor(() =>
    expect(screen.queryByText("Couldn't load sharing settings. Try again before making changes.") === null).toBe(true),
  );
  expect(screen.getByRole("button", { name: "Save" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(writes).toBe(0);
});
