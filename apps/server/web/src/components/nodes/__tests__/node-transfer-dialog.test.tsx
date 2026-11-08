import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";
import { NodeTransferDialog } from "../node-transfer-dialog";

/**
 * `POST /api/nodes/:id/transfer` from the browser (spec 2026-11-07). The
 * dialog is the only human door to ownership change, so its shape is the
 * product decision: a recipient picker that never offers yourself, the
 * share-back checkbox defaulting ON, and one POST naming both.
 */

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

function mockTransfer() {
  const posts: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/auth/get-session") {
      return Promise.resolve(Response.json({ user: { id: "u1", name: "Alice", email: "alice@subshell.local" } }));
    }
    if (url.pathname === "/api/users") {
      return Promise.resolve(
        Response.json({
          viewerIsAdmin: false,
          users: [
            { id: "u1", email: "alice@subshell.local", name: "Alice" },
            { id: "u2", email: "bob@subshell.local", name: "Bob" },
          ],
        }),
      );
    }
    if (url.pathname === "/api/nodes/n1/transfer" && method === "POST") {
      posts.push({ url: url.pathname, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(Response.json({ nodeId: "n1", ownerUserId: "u2", retainedAccessAsManager: true }));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  return { posts };
}

function renderDialog(onDone = () => {}) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The better-auth client bakes in its fetch at module load, so the session
  // can't be intercepted by the fetch mock here; the query cache IS the
  // dialog's window on the viewer, so the test seeds the viewer directly.
  cache.setQueryData(CURRENT_USER_QUERY_KEY, { id: "u1", name: "Alice", email: "alice@subshell.local" });
  return render(
    <QueryClientProvider client={cache}>
      <NodeTransferDialog nodeId="n1" nodeName="workbox" open onOpenChange={() => {}} onDone={onDone} />
    </QueryClientProvider>,
  );
}

it("transfers to the chosen account, keeping manage by default", async () => {
  const { posts } = mockTransfer();
  let done = 0;
  renderDialog(() => done++);
  // The named machine sits in the body, never in the fixed title.
  expect(await screen.findByText(/workbox/)).toBeTruthy();
  const picker = await screen.findByRole("combobox", { name: "New owner" });
  const transfer = screen.getByRole("button", { name: /^Transfer/ });
  expect(transfer.matches(":disabled, [aria-disabled=true]")).toBe(true);
  fireEvent.mouseDown(picker);
  fireEvent.click(picker);
  // Yourself is not an option on your own transfer dialog.
  expect(await screen.findByRole("option", { name: "bob@subshell.local" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "alice@subshell.local" }) === null).toBe(true);
  fireEvent.click(screen.getByRole("option", { name: "bob@subshell.local" }));

  fireEvent.click(screen.getByRole("button", { name: /^Transfer/ }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]?.body).toEqual({ toUserId: "u2", retainAccessAsManager: true });
  await waitFor(() => expect(done).toBe(1));
});

it("a failed people roster says so and recovers on Retry, never 'no matching people'", async () => {
  // An empty list and a failed read are different answers: showing the
  // picker's empty text over a dead roster tells the owner the instance has
  // nobody, when the truth is the read could not run (sharing-core idiom).
  let failed = true;
  let rosterReads = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/users") {
      rosterReads++;
      return failed
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({
            viewerIsAdmin: false,
            users: [{ id: "u2", email: "bob@subshell.local", name: "Bob" }],
          });
    }
    return Response.json({});
  }) as typeof fetch;
  renderDialog();
  expect(await screen.findByText("Couldn't load the people list. Try again.")).toBeTruthy();
  expect(screen.queryByText("No matching people to hand it to.") === null).toBe(true);
  expect(screen.getByRole("button", { name: /^Transfer/ }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(rosterReads).toBeGreaterThan(1));
  expect(await screen.findByRole("combobox", { name: "New owner" })).toBeTruthy();
});

it("unchecked share-back transfers clean", async () => {
  const { posts } = mockTransfer();
  renderDialog();
  await screen.findByRole("combobox", { name: "New owner" });
  const box = screen.getByRole("checkbox", { name: /Keep managing it yourself/ });
  expect(box.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(box);
  expect(box.getAttribute("aria-checked")).toBe("false");

  const picker = screen.getByRole("combobox", { name: "New owner" });
  fireEvent.mouseDown(picker);
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: "bob@subshell.local" }));
  fireEvent.click(screen.getByRole("button", { name: /^Transfer/ }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]?.body).toEqual({ toUserId: "u2", retainAccessAsManager: false });
});
