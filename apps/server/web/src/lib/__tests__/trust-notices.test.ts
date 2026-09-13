import { describe, expect, it } from "bun:test";
import { trustNoticesFor } from "@/lib/trust-notices";
import type { Node } from "@/types/node";
import type { SubshellView } from "@/types/subshell";

/** A minimal subshell view — only the fields the notices actually read. */
function subshell(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: "p",
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/tmp",
    status: "running",
    createdAt: "2026-09-05T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "active",
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
  return {
    id: "n1",
    name: "buildbox",
    kind: "agent",
    access: "edit",
    status: "online",
    ...over,
  } as Node;
}

describe("trustNoticesFor — foreign node", () => {
  it("warns when the subshell runs on an agent node the caller does not own", () => {
    const notices = trustNoticesFor(subshell({ nodeId: "n1" }), [node()]);
    const foreign = notices.find((notice) => notice.kind === "foreign-node");
    expect(foreign).toBeDefined();
    expect(foreign?.banner).toContain("buildbox");
    // The two things that actually leak, both named.
    expect(foreign?.banner).toContain("transcript");
    expect(foreign?.banner).toContain("credentials");
  });

  it("stays quiet on a node the caller owns", () => {
    const notices = trustNoticesFor(subshell({ nodeId: "n1" }), [node({ access: "owner" })]);
    expect(notices.map((notice) => notice.kind)).not.toContain("foreign-node");
  });

  it("stays quiet on the control-plane host", () => {
    // A non-admin's access to the seeded `local` node is `edit` via its
    // Everyone grant — the strict rule would fire on the default node for
    // every ordinary user, in every session, which is a warning nobody reads.
    const notices = trustNoticesFor(subshell({ nodeId: "local" }), [
      node({ id: "local", name: "This machine", kind: "local", access: "edit" }),
    ]);
    expect(notices.map((notice) => notice.kind)).not.toContain("foreign-node");
  });

  it("stays quiet when the node is not in the caller's list", () => {
    // Absence of data is not evidence of exposure: an unresolvable node must
    // not produce a warning naming a machine we cannot describe.
    expect(trustNoticesFor(subshell({ nodeId: "gone" }), [])).toEqual([]);
    expect(trustNoticesFor(subshell({ nodeId: "gone" }), undefined)).toEqual([]);
  });
});

describe("trustNoticesFor — sharing", () => {
  it("warns the owner that the scrollback goes too", () => {
    const notices = trustNoticesFor(subshell({ shareCount: 2 }), []);
    const shared = notices.find((notice) => notice.kind === "shared");
    expect(shared?.banner).toContain("2 other people");
    // The non-obvious half — a grant is not "from now on".
    expect(shared?.banner).toContain("before you shared it");
  });

  it("tells a guest whose subshell they are in", () => {
    const shared = trustNoticesFor(subshell({ shareCount: 1, access: "edit" }), []).find(
      (notice) => notice.kind === "shared",
    );
    expect(shared?.banner).toContain("belongs to someone else");
    expect(shared?.label).toBe("Someone else's subshell");
  });

  it("names an Everyone grant as uncountable rather than as one person", () => {
    const shared = trustNoticesFor(subshell({ shareCount: 1, sharedWithEveryone: true }), []).find(
      (notice) => notice.kind === "shared",
    );
    expect(shared?.banner).toContain("everyone signed in to this instance");
    expect(shared?.banner).not.toContain("1 other person");
  });

  it("stays quiet on a private subshell, including one from an older payload", () => {
    expect(trustNoticesFor(subshell({ shareCount: 0 }), [])).toEqual([]);
    // A payload predating the field must read as private, never as unknown.
    expect(trustNoticesFor(subshell({ shareCount: undefined }), [])).toEqual([]);
  });

  it("re-keys when the audience changes, so a widened share is new news", () => {
    const before = trustNoticesFor(subshell({ shareCount: 1 }), [])[0];
    const after = trustNoticesFor(subshell({ shareCount: 4 }), [])[0];
    expect(before?.dismissKey).not.toBe(after?.dismissKey);
  });
});

describe("trustNoticesFor — ordering", () => {
  it("puts the node ahead of the share: it is wider, and it cannot be revoked", () => {
    const notices = trustNoticesFor(subshell({ nodeId: "n1", shareCount: 3 }), [node()]);
    expect(notices.map((notice) => notice.kind)).toEqual(["foreign-node", "shared"]);
  });

  it("has nothing to say about a private subshell on your own machine", () => {
    expect(trustNoticesFor(subshell(), [node({ id: "local", kind: "local", access: "owner" })])).toEqual([]);
  });

  it("has nothing to say while the subshell is still loading", () => {
    expect(trustNoticesFor(undefined, [node()])).toEqual([]);
  });
});
