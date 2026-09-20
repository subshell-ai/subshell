import { describe, expect, it } from "bun:test";
import { type Access, resolveSubshellAccess } from "@/lib/subshell-access.js";
import { ADMINS_TOPIC, EVERYONE_TOPIC, recipientTopics, topicsForViewer, userTopic } from "@/ws/live-topics.js";

type Share = { granteeUserId: string | null; permission: "view" | "edit" };

describe("live topics", () => {
  it("names a viewer's own topic distinctly per user", () => {
    expect(userTopic("u1")).not.toBe(userTopic("u2"));
    expect(topicsForViewer({ viewerId: "u1", isAdmin: false })).toEqual([userTopic("u1"), EVERYONE_TOPIC]);
  });

  it("puts an admin on the admins topic as well", () => {
    expect(topicsForViewer({ viewerId: "u1", isAdmin: true })).toEqual([userTopic("u1"), EVERYONE_TOPIC, ADMINS_TOPIC]);
  });

  it("routes a private row to its owner and the admins, and nobody else", () => {
    expect(recipientTopics({ ownerUserId: "owner", shares: [] })).toEqual([userTopic("owner"), ADMINS_TOPIC]);
  });

  it("adds each explicit grantee's own topic", () => {
    const topics = recipientTopics({
      ownerUserId: "owner",
      shares: [
        { granteeUserId: "a", permission: "view" },
        { granteeUserId: "b", permission: "edit" },
      ],
    });
    expect(topics).toContain(userTopic("a"));
    expect(topics).toContain(userTopic("b"));
    expect(topics).not.toContain(EVERYONE_TOPIC);
  });

  it("uses the everyone topic for an Everyone share rather than expanding it", () => {
    const topics = recipientTopics({
      ownerUserId: "owner",
      shares: [{ granteeUserId: null, permission: "view" }],
    });
    expect(topics).toContain(EVERYONE_TOPIC);
    // The whole point: no user ids beyond the owner's appear — an Everyone
    // grant must never expand into one topic per account.
    expect(topics.filter((t) => t.startsWith("live:u:"))).toEqual([userTopic("owner")]);
  });

  it("emits no duplicate topics when a grantee is also the owner", () => {
    const topics = recipientTopics({
      ownerUserId: "owner",
      shares: [{ granteeUserId: "owner", permission: "edit" }],
    });
    expect(topics.length).toBe(new Set(topics).size);
  });
});

/**
 * **The mechanism that makes a second authorization implementation safe.**
 *
 * `recipientTopics` runs row → viewers; every other access helper in the tree
 * (`resolveSubshellAccess`, `listVisibleTo`) runs viewer → row. Two
 * implementations of one policy is only dangerous when nothing diffs them, so
 * this diffs them exhaustively: over every combination of owner/admin/explicit
 * grant/Everyone grant, a viewer is reachable by the published topics exactly
 * when the ordinary gate would grant them access.
 *
 * If this test is deleted or weakened, the fan-out has lost the thing that
 * makes it sound and should go back to resolving per subscriber (spec
 * 2026-09-19 §4.1a).
 */
describe("recipientTopics agrees with resolveSubshellAccess, exhaustively", () => {
  const OWNER = "owner";
  const VIEWERS = [OWNER, "grantee", "stranger"] as const;
  const GRANT_OPTIONS: Share[][] = [
    [],
    [{ granteeUserId: "grantee", permission: "view" }],
    [{ granteeUserId: "grantee", permission: "edit" }],
    [{ granteeUserId: null, permission: "view" }],
    [{ granteeUserId: null, permission: "edit" }],
    [
      { granteeUserId: "grantee", permission: "edit" },
      { granteeUserId: null, permission: "view" },
    ],
    [{ granteeUserId: "stranger", permission: "view" }],
  ];

  it("reachable-by-topic ⟺ access !== none, for every combination", () => {
    let checked = 0;
    for (const shares of GRANT_OPTIONS) {
      const published = new Set(recipientTopics({ ownerUserId: OWNER, shares }));
      for (const viewerId of VIEWERS) {
        for (const isAdmin of [false, true]) {
          const subscribed = topicsForViewer({ viewerId, isAdmin });
          const reachable = subscribed.some((t) => published.has(t));
          const access: Access = resolveSubshellAccess(viewerId, isAdmin, OWNER, shares);
          expect({ viewerId, isAdmin, shares, reachable }).toEqual({
            viewerId,
            isAdmin,
            shares,
            reachable: access !== "none",
          });
          checked += 1;
        }
      }
    }
    // Guards against a refactor that silently empties the fixture space and
    // leaves a test that asserts nothing.
    expect(checked).toBe(GRANT_OPTIONS.length * VIEWERS.length * 2);
  });
});
