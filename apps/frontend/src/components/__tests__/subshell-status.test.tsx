import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { RowStatusBadges } from "@/components/subshell-status";
import type { SubshellView } from "@/types/subshell";

/** A full SubshellView with overridable fields (harness copied from existing-subshell-list.test.tsx). */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "id-1",
    profileId: "profile-1",
    harnessId: "claude",
    name: "subshell",
    nameLocked: false,
    terminalReplayLines: null,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-08-30T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    nodeOffline: false,
    ...overrides,
  };
}

describe("RowStatusBadges", () => {
  afterEach(cleanup);

  it("replaces BOTH chips with 'node unreachable' when the node is offline (spec §5.6)", () => {
    render(
      <RowStatusBadges
        subshell={makeSubshell({ nodeOffline: true, waitingSince: "2026-08-30T00:00:00.000Z", activity: "active" })}
      />,
    );
    // A downed agent makes alive/waitingSince last-known facts — neither a
    // status assertion nor a waiting claim may render (subshell-card.tsx
    // accessoryFor is the sibling implementation this mirrors).
    expect(screen.getByText("node unreachable")).toBeDefined();
    expect(screen.queryByText("waiting for you")).toBeNull();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("ended")).toBeNull();
    expect(screen.queryByText("exited")).toBeNull();
  });

  it("shows StatusChip AND WaitingChip for an online waiting subshell (current behavior pinned)", () => {
    render(<RowStatusBadges subshell={makeSubshell({ waitingSince: "2026-08-30T00:00:00.000Z" })} />);
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByText("waiting for you")).toBeDefined();
    expect(screen.queryByText("node unreachable")).toBeNull();
  });

  it("leaves an online terminated row reading 'ended', never waiting", () => {
    // Stale waitingSince stamp on a dead row — isWaiting's guards suppress the chip.
    render(
      <RowStatusBadges
        subshell={makeSubshell({ status: "terminated", alive: false, waitingSince: "2026-08-30T00:00:00.000Z" })}
      />,
    );
    expect(screen.getByText("ended")).toBeDefined();
    expect(screen.queryByText("waiting for you")).toBeNull();
    expect(screen.queryByText("running")).toBeNull();
  });

  it("outranks even 'ended' when the node is offline (offline-first precedence)", () => {
    render(<RowStatusBadges subshell={makeSubshell({ status: "terminated", alive: false, nodeOffline: true })} />);
    expect(screen.getByText("node unreachable")).toBeDefined();
    expect(screen.queryByText("ended")).toBeNull();
  });
});
