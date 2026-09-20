import { describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import type { SubshellView } from "@/types/subshell";

/** A minimal subshell view — only the fields grouping and ranking read. */
function subshell(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    endedAt: null,
    // No `lastOutputAt`, so the indicator falls back to the server's own
    // `activity` field and nothing here depends on the wall clock.
    lastOutputAt: null,
    activity: "idle",
    preview: [],
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    nameLocked: false,
    notify: true,
    waitingSince: null,
    access: "owner",
    shareCount: 0,
    sharedWithEveryone: false,
    ...over,
  } as SubshellView;
}

function node(over: Partial<Node> = {}): Node {
  return { id: "n1", name: "buildbox", kind: "agent", access: "edit", status: "online", ...over } as Node;
}

describe("groupSubshellsByNode — bucketing", () => {
  it("puts each subshell under its own node", () => {
    const groups = groupSubshellsByNode(
      [subshell({ id: "a", nodeId: "local" }), subshell({ id: "b", nodeId: "n1" })],
      [node({ id: "local", name: "Server", kind: "local" }), node()],
    );
    expect(groups.map((g) => g.nodeId)).toEqual(["local", "n1"]);
    expect(groups.map((g) => g.subshells.map((s) => s.id))).toEqual([["a"], ["b"]]);
  });

  it("keeps the caller's order inside a group — it re-buckets, it never re-sorts", () => {
    const groups = groupSubshellsByNode(
      [subshell({ id: "a" }), subshell({ id: "b" }), subshell({ id: "c" })],
      [node({ id: "local", name: "Server" })],
    );
    expect(groups[0]?.subshells.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("buckets a payload with no nodeId as the control-plane host", () => {
    // Older cached rows predate the field; the backend always put those on
    // `local`, so they must not become a nameless seventh group.
    const groups = groupSubshellsByNode([subshell({ nodeId: undefined })], [node({ id: "local", name: "Server" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodeId).toBe("local");
    expect(groups[0]?.label).toBe("Server");
  });

  it("returns nothing for an empty list", () => {
    expect(groupSubshellsByNode([], [node()])).toEqual([]);
  });
});

describe("groupSubshellsByNode — labels", () => {
  it("renders the node's NAME, never its id — a rename must reach the rail", () => {
    const groups = groupSubshellsByNode([subshell({ nodeId: "local" })], [node({ id: "local", name: "Workshop Mac" })]);
    expect(groups[0]?.label).toBe("Workshop Mac");
  });

  it("wears the short id, with the full one as hover text, while the registry has not answered", () => {
    // Absence proves nothing yet: a cold load must not flash a verdict about
    // a machine above every row before the registry answers.
    const groups = groupSubshellsByNode([subshell({ nodeId: "abcdef0123456789" })], undefined, { unanswered: true });
    expect(groups[0]?.label).toBe("abcdef01");
    expect(groups[0]?.title).toBe("abcdef0123456789");
  });

  it("reads a FAILED registry as unanswered, never as a verdict — `local` cannot be deleted", () => {
    // The card can dodge this by returning null for `local` outright; this
    // header labels every node including the control-plane host, so a flaky
    // /api/nodes must wear the short id, not "unknown node".
    const groups = groupSubshellsByNode([subshell({ nodeId: "local" })], undefined, { unanswered: true });
    expect(groups[0]?.label).toBe("local");
  });

  it("says 'unknown node', with the id on hover, once the registry ANSWERED without the id", () => {
    // Not "deleted node": the list is share-filtered, so a revoked grant
    // lands here too, and "unknown" claims only what is known.
    const groups = groupSubshellsByNode([subshell({ nodeId: "gone" })], [node()], { unanswered: false });
    expect(groups[0]?.label).toBe("unknown node");
    expect(groups[0]?.title).toBe("gone");
  });

  it("makes the hover title the NAME once the registry resolves it", () => {
    const groups = groupSubshellsByNode([subshell({ nodeId: "n1" })], [node()], { unanswered: false });
    expect(groups[0]?.title).toBe("buildbox");
  });
});

describe("groupSubshellsByNode — ordering", () => {
  it("sorts groups by their liveliest member, not by node order", () => {
    // `local` is discovered first but holds only an ended session; the node
    // with someone waiting has to come first or grouping buries the one row
    // the status band exists to surface.
    const groups = groupSubshellsByNode(
      [
        subshell({ id: "waiting", nodeId: "n1", waitingSince: "2026-09-20T00:00:00.000Z" }),
        subshell({ id: "dead", nodeId: "local", status: "terminated", activity: "terminated", alive: false }),
      ],
      [node({ id: "local", name: "Server" }), node()],
    );
    expect(groups.map((g) => g.nodeId)).toEqual(["n1", "local"]);
  });

  it("ranks a group by its LIVELIEST member, not its first row", () => {
    // The input's sort ran once, against the data; activity is re-derived
    // against the CLOCK on every render. So the FIRST row of a bucket can
    // have gone idle underneath a group whose second row is still printing,
    // and the header must not demote the machine on the strength of a row
    // that merely got there first.
    const groups = groupSubshellsByNode(
      [
        subshell({ id: "b1", nodeId: "n1", activity: "idle" }),
        subshell({ id: "a1", nodeId: "local", activity: "active" }),
        subshell({ id: "b2", nodeId: "n1", activity: "active" }),
      ],
      [node({ id: "local", name: "Server" }), node()],
    );
    expect(groups.map((g) => g.nodeId)).toEqual(["n1", "local"]);
  });

  it("keeps discovery order when two groups rank equally", () => {
    const groups = groupSubshellsByNode(
      [subshell({ id: "a", nodeId: "local" }), subshell({ id: "b", nodeId: "n1" })],
      [node({ id: "local", name: "Server" }), node()],
    );
    expect(groups.map((g) => g.nodeId)).toEqual(["local", "n1"]);
  });
});

describe("groupSubshellsByNode — the cap", () => {
  it("applies the limit PER GROUP, so one machine cannot crowd out another", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => subshell({ id: `l${i}`, nodeId: "local" })),
      ...Array.from({ length: 3 }, (_, i) => subshell({ id: `n${i}`, nodeId: "n1" })),
    ];
    const groups = groupSubshellsByNode(rows, [node({ id: "local", name: "Server" }), node()], { limit: 2 });
    expect(groups.map((g) => g.subshells.map((s) => s.id))).toEqual([
      ["l0", "l1"],
      ["n0", "n1"],
    ]);
  });

  it("reports the pre-cap count so a header can say what it is hiding", () => {
    const rows = Array.from({ length: 5 }, (_, i) => subshell({ id: `s${i}` }));
    const groups = groupSubshellsByNode(rows, [node({ id: "local", name: "Server" })], { limit: 2 });
    expect(groups[0]?.subshells).toHaveLength(2);
    expect(groups[0]?.total).toBe(5);
  });

  it("caps nothing when no limit is given (filter mode shows every match)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => subshell({ id: `s${i}` }));
    const groups = groupSubshellsByNode(rows, [node({ id: "local", name: "Server" })]);
    expect(groups[0]?.subshells).toHaveLength(12);
  });
});
