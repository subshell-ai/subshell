import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SaveWorkspaceDialog } from "@/components/save-workspace-dialog";
import type { WorkspaceRow } from "@/types/workspace";

const restore: (() => void)[] = [];

const draft: WorkspaceRow = {
  id: "w1",
  name: "api rewrite",
  layout: null,
  subshellCount: 2,
  draft: true,
  createdAt: "2026-09-14T16:45:00.000Z",
  updatedAt: "2026-09-14T16:45:00.000Z",
};

/** Answers the promotion PUT with `status`, recording what was sent. */
function stubFetch(status: number): { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== "/api/workspaces/w1") throw new Error(`unexpected fetch: ${url}`);
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { message: "name taken" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { sent };
}

function renderDialog(): { closed: boolean[] } {
  const closed: boolean[] = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SaveWorkspaceDialog workspace={draft} open onOpenChange={(next) => closed.push(next)} />
    </QueryClientProvider>,
  );
  return { closed };
}

describe("SaveWorkspaceDialog", () => {
  afterEach(() => {
    cleanup();
    for (const undo of restore.splice(0)) undo();
  });

  it("prefills the draft's own name", async () => {
    renderDialog();
    const field = (await screen.findByLabelText("Workspace name")) as HTMLInputElement;
    expect(field.value).toBe("api rewrite");
  });

  it("promotes the draft in one call and closes", async () => {
    const { sent } = stubFetch(200);
    const { closed } = renderDialog();
    const field = await screen.findByLabelText("Workspace name");
    fireEvent.change(field, { target: { value: "  API rewrite  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => {
      expect(sent).toEqual([{ name: "API rewrite", draft: false }]);
    });
    await waitFor(() => {
      expect(closed).toContain(false);
    });
  });

  it("turns the duplicate-name 409 into something a human can act on", async () => {
    stubFetch(409);
    const { closed } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Save workspace" }));
    expect(await screen.findByText("You already have a workspace with that name")).toBeTruthy();
    expect(closed).toEqual([]);
  });

  it("refuses to save a blank name", async () => {
    stubFetch(200);
    renderDialog();
    const field = await screen.findByLabelText("Workspace name");
    fireEvent.change(field, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save workspace" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
