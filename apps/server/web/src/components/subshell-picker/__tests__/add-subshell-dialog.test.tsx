import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // The base list gets the same freshness pin as the filtered halves below:
  // a seeded cache at the default staleTime is STALE on mount, so the dialog's
  // observer refetches it for real. On CI that refetch hits a refused port 80,
  // the failure flips subshellsFailed, and the mode switch the newOnly branch
  // just hid reappears mid-assertion (laptop green only because a real server
  // answers this machine's :80). Nothing in these tests wants a live list.
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
    expect(screen.getByText("remote")).toBeTruthy();
  });

  it("disables the mode switch while an add is in flight", async () => {
    // The pre-newOnly suite asserted this through the old dialog; the branch
    // is unchanged and still needs a pin: no mode flip (or double add) while
    // an add is running. The click retries inside waitFor because the list
    // re-renders once the filtered queries hydrate: on a starved runner the
    // first click can land on an element React has already replaced, and a
    // detached node dispatches events the root never sees. EVERY pending
    // promise is released, so a failure mid-loop cannot leave the dialog
    // mounted busy into the next test.
    const releases: (() => void)[] = [];
    renderDialog({
      excludeSubshellIds: [],
      onAdd: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    });
    await screen.findByText("other");
    try {
      await waitFor(() => {
        fireEvent.click(screen.getByRole("button", { name: /other/ }));
        expect(screen.getByRole("button", { name: "Existing subshell" }).closest("fieldset[disabled]")).not.toBeNull();
      });
    } finally {
      await act(async () => {
        for (const release of releases) release();
      });
    }
  });

  it("opens the launch form directly when every subshell is already included", async () => {
    renderDialog({ excludeSubshellIds: ["here", "other", "remote"] });
    expect(await screen.findByRole("heading", { name: "New subshell" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start subshell" })).toBeTruthy();
    expect(screen.queryByText("Existing subshell")).toBeNull();
    expect(screen.queryByPlaceholderText(/Search by name/)).toBeNull();
    expect(screen.queryByText(/Every subshell is already/)).toBeNull();
  });

  it("lists available subshells across nodes even when the launch draft names one", async () => {
    renderDialog({ excludeSubshellIds: [], initialForm: { nodeId: "box" } });
    expect(await screen.findByText("remote")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
  });
});
