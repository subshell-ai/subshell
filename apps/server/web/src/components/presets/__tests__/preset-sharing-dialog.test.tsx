import { afterEach, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SharingDialogCore } from "@/components/sharing-dialog-core";
import { PresetSharingDialog } from "../preset-sharing-dialog";

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
      <PresetSharingDialog id="p" kind="agent" onClose={() => {}} />
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

it("keeps sharing open and disables edits until a pending save finishes", async () => {
  let finish!: () => void;
  const closed: boolean[] = [];
  render(
    <SharingDialogCore
      open
      onOpenChange={(open) => closed.push(open)}
      title="Share preset"
      description="Share settings"
      isLoading={false}
      serverGrants={[{ granteeUserId: null, permission: "view" }]}
      roster={[]}
      saving={false}
      onSave={() =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove access for Everyone" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("button", { name: "Cancel" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  expect(screen.getByRole("button", { name: "Add" }).matches(":disabled, [aria-disabled=true]")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
  expect(closed).toHaveLength(0);
  await act(async () => finish());
  await waitFor(() => expect(closed).toEqual([false]));
});
