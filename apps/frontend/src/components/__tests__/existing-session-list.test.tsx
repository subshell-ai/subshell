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

  describe("node filter (display-only, spec §9 dialog coherence)", () => {
    const onLocal = makeSession({ id: "l", name: "local-one", nodeId: "local" });
    // A legacy payload without nodeId reads as local — same tolerance the
    // card mirror documents, so a stale cache entry never vanishes.
    const legacyLocal = makeSession({ id: "g", name: "legacy-one" });
    const onRemote = makeSession({ id: "r", name: "remote-one", nodeId: "mac" });

    it("shows every session when no node is given", () => {
      render(<ExistingSessionList {...base} sessions={[onLocal, legacyLocal, onRemote]} />);
      expect(screen.getAllByRole("button").length).toBe(3);
    });

    it("keeps local (explicit or legacy) under nodeId=local", () => {
      render(<ExistingSessionList {...base} sessions={[onLocal, legacyLocal, onRemote]} nodeId="local" />);
      const text = screen
        .getAllByRole("button")
        .map((r) => r.textContent)
        .join();
      expect(text).toContain("local-one");
      expect(text).toContain("legacy-one");
      expect(text).not.toContain("remote-one");
    });

    it("keeps only the node's own sessions under a remote nodeId", () => {
      render(<ExistingSessionList {...base} sessions={[onLocal, legacyLocal, onRemote]} nodeId="mac" />);
      const rows = screen.getAllByRole("button");
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain("remote-one");
    });

    it("names the node when sessions exist but none are on it", () => {
      render(<ExistingSessionList {...base} sessions={[onLocal]} nodeId="mac" />);
      expect(screen.getByText(/No sessions on this node/)).toBeDefined();
      // …and does NOT claim the workspace already holds them all.
      expect(screen.queryByText(/Every session is already on this workspace/)).toBeNull();
    });

    it("still claims full attachment for an empty unfiltered list", () => {
      render(<ExistingSessionList {...base} sessions={[]} nodeId="mac" />);
      expect(screen.getByText(/Every session is already on this workspace/)).toBeDefined();
    });
  });
});
