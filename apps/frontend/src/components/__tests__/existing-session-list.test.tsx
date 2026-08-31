import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ExistingSessionList } from "@/components/session-picker/existing-session-list";
import type { SessionView } from "@/types/session";

/** A full SessionView with overridable fields — sessions list empty by default. */
function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "id-1",
    profileId: "profile-1",
    harnessId: "claude",
    name: "session",
    nameLocked: false,
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
    ...overrides,
  };
}

const base = {
  sessions: [],
  query: "",
  onQueryChange: () => {},
  loadFailed: false,
  loading: false,
  onPick: () => {},
  busyId: null,
};

describe("ExistingSessionList", () => {
  afterEach(cleanup);

  it("says it's loading while the list is cold, instead of claiming the workspace has them all", () => {
    render(<ExistingSessionList {...base} loading />);
    expect(screen.getByText("Loading sessions…")).toBeDefined();
    expect(screen.queryByText(/Every session is already on this workspace/)).toBeNull();
  });

  it("still claims nothing to add for a genuinely empty (loaded) list", () => {
    render(<ExistingSessionList {...base} />);
    expect(screen.getByText(/Every session is already on this workspace/)).toBeDefined();
  });

  it("distinguishes a failed load from an empty list", () => {
    render(<ExistingSessionList {...base} loadFailed />);
    expect(screen.getByText("Couldn't load sessions.")).toBeDefined();
  });

  it("puts the bell-on waiting session first and chips it", () => {
    const dead = makeSession({ id: "dead", name: "dead-one", status: "terminated", alive: false });
    const plain = makeSession({ id: "plain", name: "plain-running" });
    const waiting = makeSession({
      id: "waiting",
      name: "waiting-one",
      notify: true,
      waitingSince: "2026-08-30T00:00:00.000Z",
    });
    render(<ExistingSessionList {...base} sessions={[dead, plain, waiting]} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0]?.textContent).toContain("waiting-one");
    expect(rows[0]?.textContent).toContain("waiting for you");
  });
});
