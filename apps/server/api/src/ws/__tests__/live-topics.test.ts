import { describe, expect, it } from "bun:test";
import { type Access, resolveSubshellAccess } from "@/lib/subshell-access.js";
import { ADMINS_TOPIC, EVERYONE_TOPIC, recipientTopics, topicsForViewer, userTopic } from "@/ws/live-topics.js";

type Share = { granteeUserId: string | null; permission: "view" | "edit" };

describe("live topics", () => {
  it("names a viewer's own topic distinctly per user", () => {
    expect(userTopic("u1")).not.toBe(userTopic("u2"));
    expect(topicsForViewer({ viewerId: "u1", isAdmin: false })).toEqual([userTopic("u1"), EVERYONE_TOPIC]);
  });

  it("puts an admin on the admins topic ALONE, so an admin owner is not served twice", () => {
    // `admins` already carries every row (instance-wide edit), so adding this
    // viewer's own topic would deliver a row they own two times — measured
    // against a real server before the sets were made disjoint.
    expect(topicsForViewer({ viewerId: "u1", isAdmin: true })).toEqual([ADMINS_TOPIC]);
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

  it("publishes an Everyone-shared row to `everyone` only, naming no user at all", () => {
    const topics = recipientTopics({
      ownerUserId: "owner",
      shares: [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "a", permission: "edit" },
      ],
    });
    // Everyone INCLUDES the owner and every grantee, so naming their topics
    // too would deliver the frame twice. And an Everyone grant must never
    // expand into one topic per account — that is the whole point of a topic.
    expect(topics).toEqual([EVERYONE_TOPIC, ADMINS_TOPIC]);
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
    // The owner ALSO named explicitly: the one shape where a naive
    // implementation emits their topic twice.
    [{ granteeUserId: OWNER, permission: "edit" }],
    // Two distinct non-owner grantees, so the loop is exercised rather than
    // just its first iteration.
    [
      { granteeUserId: "grantee", permission: "view" },
      { granteeUserId: "stranger", permission: "edit" },
    ],
  ];

  it("matches EXACTLY ONCE ⟺ access !== none, for every combination", () => {
    let checked = 0;
    for (const shares of GRANT_OPTIONS) {
      const published = new Set(recipientTopics({ ownerUserId: OWNER, shares }));
      for (const viewerId of VIEWERS) {
        for (const isAdmin of [false, true]) {
          const subscribed = topicsForViewer({ viewerId, isAdmin });
          // COUNT, not "some": a viewer matching two published topics would be
          // correctly authorized and served the same frame twice. Asserting
          // the count is what makes exactly-once a property rather than a hope.
          const matches = subscribed.filter((t) => published.has(t)).length;
          const access: Access = resolveSubshellAccess(viewerId, isAdmin, OWNER, shares);
          expect({ viewerId, isAdmin, shares, matches }).toEqual({
            viewerId,
            isAdmin,
            shares,
            matches: access === "none" ? 0 : 1,
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
