import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { AddSubshellDialog } from "@/components/subshell-picker/add-subshell-dialog";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

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
    nodeOffline: false,
    ...overrides,
  };
}

/** Renders the dialog open, with the subshell list already in cache. */
function renderDialog(props: { excludeSubshellIds: string[]; initialForm?: { nodeId?: string } }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(SUBSHELLS_QUERY_KEY, [
    makeSubshell({ id: "here", name: "here" }),
    makeSubshell({ id: "other", name: "other" }),
    makeSubshell({ id: "remote", name: "remote", nodeId: "box" }),
  ]);
  render(
    <QueryClientProvider client={qc}>
      <AddSubshellDialog open onOpenChange={() => {}} onAdd={async () => {}} {...props} />
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

  it("seeds the node from initialForm, so the existing half lists that machine", async () => {
    renderDialog({ excludeSubshellIds: [], initialForm: { nodeId: "box" } });
    expect(await screen.findByText("remote")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
  });
});
