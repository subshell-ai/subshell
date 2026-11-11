import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";
import type { SplitDirection } from "@/types/workspace";

function makeSubshell(overrides: Partial<SubshellView> & { id: string }): SubshellView {
  return {
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    name: overrides.id,
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-09-14T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ssh: false,
    nodeOffline: false,
    ...overrides,
  };
}

/** Renders the dialog open, with the subshell list already in cache. */
function renderDialog(props: {
  initialForm?: { nodeId?: string };
  title?: string;
  description?: string;
  onAdd?: (subshellId: string, direction: SplitDirection) => Promise<unknown>;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The launch form reads the roster and the per-node filtered halves. Pin
  // them: a seeded cache at the default staleTime is STALE on mount, and the
  // observer refetches for real. On CI that refetch hits a refused port 80.
  qc.setQueryDefaults(SUBSHELLS_QUERY_KEY, { staleTime: Infinity });
  qc.setQueryData(SUBSHELLS_QUERY_KEY, [
    makeSubshell({ id: "here", name: "here" }),
    makeSubshell({ id: "other", name: "other" }),
    makeSubshell({ id: "remote", name: "remote", nodeId: "box" }),
  ]);
  const rows = qc.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY) ?? [];
  for (const nodeId of ["local", "box"]) {
    qc.setQueryDefaults([...SUBSHELLS_QUERY_KEY, "filtered", `nodeId=${nodeId}`], { staleTime: Infinity });
    qc.setQueryData(
      [...SUBSHELLS_QUERY_KEY, "filtered", `nodeId=${nodeId}`],
      rows.filter((s) => s.nodeId === nodeId),
    );
  }
  function DialogHarness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen add
        </button>
        <AddSubshellDialog open={open} onOpenChange={setOpen} {...props} onAdd={props.onAdd ?? (async () => {})} />
      </>
    );
  }
  render(
    <QueryClientProvider client={qc}>
      <DialogHarness />
    </QueryClientProvider>,
  );
}

describe("AddSubshellDialog", () => {
  afterEach(cleanup);

  it.each(["Cancel", "Close"])("%s discards the launch draft", async (action) => {
    renderDialog({});
    await screen.findByRole("heading", { name: "Add a subshell" });
    const field = document.querySelector<HTMLInputElement>("#picker-working-dir");
    if (!field) throw new Error("Working directory input is missing");
    const initial = field.value;
    fireEvent.change(field, { target: { value: "/tmp/discard-this-draft" } });
    expect(field.value).toBe("/tmp/discard-this-draft");
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Reopen add" }));
    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#picker-working-dir")?.value).toBe(initial));
  });

  it("offers only the launch form, with no existing-subshell choice", async () => {
    renderDialog({});
    expect(await screen.findByRole("heading", { name: "Add a subshell" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start subshell" })).toBeTruthy();
    expect(screen.queryByText("Existing subshell")).toBeNull();
    expect(screen.queryByPlaceholderText(/Search by name/)).toBeNull();
  });

  it("a caller's title and description name the flow", async () => {
    renderDialog({ title: "Split", description: "Split this pane beside another subshell." });
    expect(await screen.findByRole("heading", { name: "Split" })).toBeTruthy();
    expect(screen.getByText("Split this pane beside another subshell.")).toBeTruthy();
  });
});
