import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  excludeSubshellIds: string[];
  initialForm?: { nodeId?: string };
  onAdd?: (subshellId: string, direction: SplitDirection) => Promise<unknown>;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  render(
    <QueryClientProvider client={qc}>
      <AddSubshellDialog open onOpenChange={() => {}} {...props} onAdd={props.onAdd ?? (async () => {})} />
    </QueryClientProvider>,
  );
}

describe("AddSubshellDialog", () => {
  afterEach(cleanup);

  it("leaves out the subshells it was told to exclude", async () => {
    renderDialog({ excludeSubshellIds: ["here"] });
    expect(await screen.findByText("other")).toBeTruthy();
    expect(screen.queryByText("here")).toBeNull();
  });

  it("disables the mode switch while an add is in flight", async () => {
    // The pre-newOnly suite asserted this through the old dialog; the branch
    // is unchanged and still needs a pin: no mode flip (or double add) while
    // an add is running.
    let release: () => void = () => {};
    renderDialog({
      excludeSubshellIds: [],
      onAdd: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    fireEvent.click(await screen.findByText("other"));
    const toggle = await screen.findByRole("button", { name: "Existing subshell" });
    expect(toggle.closest("fieldset[disabled]")).not.toBeNull();
    await act(async () => {
      release();
    });
  });

  it("opens the launch form directly when every subshell is already included", async () => {
    renderDialog({ excludeSubshellIds: ["here", "other", "remote"] });
    expect(await screen.findByRole("heading", { name: "New subshell" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start subshell" })).toBeTruthy();
    expect(screen.queryByText("Existing subshell")).toBeNull();
    expect(screen.queryByPlaceholderText(/Search by name/)).toBeNull();
    expect(screen.queryByText(/Every subshell is already/)).toBeNull();
  });

  it("seeds the node from initialForm, so the existing half lists that machine", async () => {
    renderDialog({ excludeSubshellIds: [], initialForm: { nodeId: "box" } });
    expect(await screen.findByText("remote")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
  });
});
