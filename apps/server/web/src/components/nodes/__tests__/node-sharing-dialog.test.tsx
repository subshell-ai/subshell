import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeSharingDialog } from "../node-sharing-dialog";

const original = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
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
      <NodeSharingDialog nodeId="n" open onOpenChange={() => {}} />
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
