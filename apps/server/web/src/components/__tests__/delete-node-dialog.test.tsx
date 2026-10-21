import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeleteNodeDialog } from "@/components/nodes/delete-node-dialog";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});

function open(
  options: {
    running?: number;
    online?: boolean;
    held?: boolean;
    conflict?: boolean;
    failure?: boolean;
    omitCount?: boolean;
    deleteResponse?: () => Promise<Response>;
  } = {},
) {
  const state = { running: 2, online: false, conflict: false, failure: false, ...options };
  const calls: string[] = [];
  let closed = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      calls.push(url);
      if (state.conflict && !url.includes("force=true")) {
        state.running = 2;
        return Response.json({ code: "NODE_RUNNING_SUBSHELLS", message: "Running subshells" }, { status: 409 });
      }
      if (state.deleteResponse) return state.deleteResponse();
      return Response.json({ ok: true });
    }
    if (state.failure) return Response.json({ message: "Unavailable" }, { status: 500 });
    return Response.json({
      id: "node-1",
      name: "Laptop",
      status: state.online ? "online" : "offline",
      held: state.held ? { reason: "outdated" } : null,
      ...(state.omitCount ? {} : { runningSubshells: state.running }),
    });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <DeleteNodeDialog
        node={{ id: "node-1", name: "Laptop" }}
        onClose={() => {
          closed = true;
        }}
      />
    </QueryClientProvider>,
  );
  return { calls, client, state, closed: () => closed };
}

it("requires explicit force confirmation before deleting an offline node with subshells", async () => {
  const result = open();
  const checkbox = await screen.findByRole("checkbox", { name: "Force delete this node" });
  const submit = screen.getByRole("button", { name: "Delete node" });
  expect(submit.matches(":disabled, [aria-disabled=true]")).toBe(true);
  fireEvent.click(submit);
  expect(result.calls).toEqual([]);
  fireEvent.click(checkbox);
  await waitFor(() => expect(submit.matches(":disabled, [aria-disabled=true]")).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1?force=true"]));
  await waitFor(() => expect(result.closed()).toBe(true));
});

it("deletes a node without subshells without sending force", async () => {
  const result = open({ running: 0 });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(false),
  );
  expect(screen.queryByRole("checkbox") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1"]));
});

it("keeps an online node blocked even after checking force", async () => {
  const result = open({ online: true });
  fireEvent.click(await screen.findByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(result.calls).toEqual([]);
});

it("turns a racing running-subshells refusal into an unchecked confirmation", async () => {
  const result = open({ running: 0, conflict: true });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  const checkbox = await screen.findByRole("checkbox");
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  expect(result.calls).toEqual(["/api/nodes/node-1"]);
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1", "/api/nodes/node-1?force=true"]));
});

it("doesn't delete when the initial node check fails", async () => {
  const result = open({ failure: true });
  await screen.findByRole("button", { name: "Retry node check" });
  expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(result.calls).toEqual([]);
});

it("cancel never sends a delete", async () => {
  const result = open();
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(result.closed()).toBe(true);
  expect(result.calls).toEqual([]);
});

it("allows force deletion for a held node, which the API treats as offline", async () => {
  const result = open({ held: true });
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1?force=true"]));
});

it("keeps deletion pending across a polling change and prevents dismissal or duplicate requests", async () => {
  const pending = Promise.withResolvers<Response>();
  const result = open({ deleteResponse: () => pending.promise });
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await screen.findByRole("button", { name: "Deleting…" });
  result.state.running = 0;
  await act(async () => {
    await result.client.refetchQueries();
  });
  const submit = screen.getByRole("button", { name: "Deleting…" });
  expect(submit.matches(":disabled, [aria-disabled=true]")).toBe(true);
  fireEvent.click(submit);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(result.closed()).toBe(false);
  expect(result.calls).toEqual(["/api/nodes/node-1?force=true"]);
  await act(async () => {
    pending.resolve(Response.json({ ok: true }));
  });
  await waitFor(() => expect(result.closed()).toBe(true));
});

it("keeps force confirmation after a refusal when an admin's detail read omits the count", async () => {
  const result = open({ omitCount: true, conflict: true });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await screen.findByRole("checkbox");
  await act(async () => {
    await result.client.refetchQueries();
  });
  expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1", "/api/nodes/node-1?force=true"]));
});

it("drops force confirmation once a fresh count shows no running subshells", async () => {
  const result = open({ running: 0, conflict: true });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete node" }).matches(":disabled, [aria-disabled=true]")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await screen.findByRole("checkbox");
  result.state.running = 0;
  result.state.conflict = false;
  await act(async () => {
    await result.client.refetchQueries();
  });
  await waitFor(() => expect(screen.queryByRole("checkbox") === null).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  await waitFor(() => expect(result.calls).toEqual(["/api/nodes/node-1", "/api/nodes/node-1"]));
});

it("keeps API failures in the dialog without closing it", async () => {
  const result = open({
    deleteResponse: async () =>
      Response.json(
        { code: "NODE_ONLINE", message: "This node is online. You can only force-delete an offline node." },
        { status: 409 },
      ),
  });
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This node is online.");
  expect(result.closed()).toBe(false);
  expect(result.calls).toEqual(["/api/nodes/node-1?force=true"]);
});
