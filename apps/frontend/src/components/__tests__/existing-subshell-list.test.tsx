import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExistingSubshellList } from "@/components/subshell-picker/existing-subshell-list";
import type { SubshellView } from "@/types/subshell";

/** A full SubshellView with overridable fields — subshells list empty by default. */
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

const base = {
  subshells: [],
  query: "",
  onQueryChange: () => {},
  loadFailed: false,
  loading: false,
  onPick: () => {},
  busyId: null,
};

describe("ExistingSubshellList", () => {
  afterEach(cleanup);

  it("says it's loading while the list is cold, instead of claiming the workspace has them all", () => {
    render(<ExistingSubshellList {...base} loading />);
    expect(screen.getByText("Loading subshells…")).toBeDefined();
    expect(screen.queryByText(/Every subshell is already on this workspace/)).toBeNull();
  });

  it("still claims nothing to add for a genuinely empty (loaded) list", () => {
    render(<ExistingSubshellList {...base} />);
    expect(screen.getByText(/Every subshell is already on this workspace/)).toBeDefined();
  });

  it("distinguishes a failed load from an empty list", () => {
    render(<ExistingSubshellList {...base} loadFailed />);
    expect(screen.getByText("Couldn't load subshells.")).toBeDefined();
  });

  it("puts the bell-on waiting subshell first and chips it", () => {
    const dead = makeSubshell({ id: "dead", name: "dead-one", status: "terminated", alive: false });
    const plain = makeSubshell({ id: "plain", name: "plain-running" });
    const waiting = makeSubshell({
      id: "waiting",
      name: "waiting-one",
      notify: true,
      waitingSince: "2026-08-30T00:00:00.000Z",
    });
    render(<ExistingSubshellList {...base} subshells={[dead, plain, waiting]} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0]?.textContent).toContain("waiting-one");
    expect(rows[0]?.textContent).toContain("waiting for you");
  });

  describe("row status chips (spec §5.6 nodeOffline precedence)", () => {
    it("chips BOTH status and waiting for an online waiting row (current behavior pinned)", () => {
      const waiting = makeSubshell({ id: "w", name: "waiting-online", waitingSince: "2026-08-30T00:00:00.000Z" });
      render(<ExistingSubshellList {...base} subshells={[waiting]} />);
      const row = screen.getAllByRole("button")[0]?.textContent ?? "";
      expect(row).toContain("running");
      expect(row).toContain("waiting for you");
      expect(row).not.toContain("node unreachable");
    });

    it("replaces both chips with 'node unreachable' for a subshell on an unreachable node", () => {
      // alive + waitingSince + activity say nothing while the agent is down —
      // the card already hides them (subshell-card.tsx accessoryFor); the
      // picker row must agree.
      const ghost = makeSubshell({
        id: "ghost",
        name: "ghost-on-mac",
        nodeId: "mac",
        nodeOffline: true,
        waitingSince: "2026-08-30T00:00:00.000Z",
        activity: "active",
      });
      render(<ExistingSubshellList {...base} subshells={[ghost]} />);
      const row = screen.getAllByRole("button")[0]?.textContent ?? "";
      expect(row).toContain("node unreachable");
      expect(row).not.toContain("waiting for you");
      expect(row).not.toContain("running");
    });

    it("keeps 'ended' for a terminated row on an online node", () => {
      const done = makeSubshell({ id: "t", name: "done-online", status: "terminated", alive: false });
      render(<ExistingSubshellList {...base} subshells={[done]} />);
      const row = screen.getAllByRole("button")[0]?.textContent ?? "";
      expect(row).toContain("ended");
      expect(row).not.toContain("node unreachable");
    });
  });

  describe("node filter (display-only, spec §9 dialog coherence)", () => {
    const onLocal = makeSubshell({ id: "l", name: "local-one", nodeId: "local" });
    // A legacy payload without nodeId reads as local — same tolerance the
    // card mirror documents, so a stale cache entry never vanishes.
    const legacyLocal = makeSubshell({ id: "g", name: "legacy-one" });
    const onRemote = makeSubshell({ id: "r", name: "remote-one", nodeId: "mac" });

    it("shows every subshell when no node is given", () => {
      render(<ExistingSubshellList {...base} subshells={[onLocal, legacyLocal, onRemote]} />);
      expect(screen.getAllByRole("button").length).toBe(3);
    });

    it("keeps local (explicit or legacy) under nodeId=local", () => {
      render(<ExistingSubshellList {...base} subshells={[onLocal, legacyLocal, onRemote]} nodeId="local" />);
      const text = screen
        .getAllByRole("button")
        .map((r) => r.textContent)
        .join();
      expect(text).toContain("local-one");
      expect(text).toContain("legacy-one");
      expect(text).not.toContain("remote-one");
    });

    it("keeps only the node's own subshells under a remote nodeId", () => {
      render(<ExistingSubshellList {...base} subshells={[onLocal, legacyLocal, onRemote]} nodeId="mac" />);
      const rows = screen.getAllByRole("button");
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain("remote-one");
    });

    it("names the node when subshells exist but none are on it", () => {
      render(<ExistingSubshellList {...base} subshells={[onLocal]} nodeId="mac" />);
      expect(screen.getByText(/No subshells on this node/)).toBeDefined();
      // …and does NOT claim the workspace already holds them all.
      expect(screen.queryByText(/Every subshell is already on this workspace/)).toBeNull();
    });

    it("still claims full attachment for an empty unfiltered list", () => {
      render(<ExistingSubshellList {...base} subshells={[]} nodeId="mac" />);
      expect(screen.getByText(/Every subshell is already on this workspace/)).toBeDefined();
    });
  });
});

describe("ExistingSubshellList (multi-select mode)", () => {
  afterEach(cleanup);

  it("renders checkbox rows and toggles via onToggle when selected + onToggle are given", () => {
    const toggled: string[] = [];
    const list = [makeSubshell({ id: "s1", name: "One" })];
    render(
      <ExistingSubshellList
        subshells={list}
        query=""
        onQueryChange={() => {}}
        loadFailed={false}
        loading={false}
        selected={new Set()}
        onToggle={(id) => toggled.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /One/ }));
    expect(toggled).toEqual(["s1"]);
  });

  it("single-pick mode is untouched when no selection props are passed", () => {
    const picked: string[] = [];
    const list = [makeSubshell({ id: "s2", name: "Two" })];
    render(
      <ExistingSubshellList
        subshells={list}
        query=""
        onQueryChange={() => {}}
        loadFailed={false}
        loading={false}
        onPick={(id) => picked.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Two/ }));
    expect(picked).toEqual(["s2"]);
  });
});
