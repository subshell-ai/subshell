import { describe, expect, it } from "bun:test";
import { type Access, resolveSubshellAccess } from "@/lib/subshell-access.js";
import {
  ADMINS_TOPIC,
  EVERYONE_TOPIC,
  recipientTopics,
  revocationTopics,
  topicsForViewer,
  userTopic,
} from "@/ws/live-topics.js";

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
/** The row's owner in both exhaustive passes below. */
const OWNER = "owner";

/** Every shape of grant a row can carry, shared by both passes. */
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

describe("recipientTopics agrees with resolveSubshellAccess, exhaustively", () => {
  const VIEWERS = [OWNER, "grantee", "stranger"] as const;

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

/**
 * **The transition half of the same guarantee**, and it had a live victim.
 *
 * Revocation was a set-difference over topic NAMES, which reads `everyone` and
 * `live:u:me` as unrelated when the first subsumes the second. Sharing your own
 * private subshell with Everyone therefore published `subshell-gone` to your
 * own topic microseconds after the row itself — and the client's `goneIds` is
 * sticky for the life of the connection, so the row stayed gone through every
 * later snapshot. Sharing a thing made it disappear.
 *
 * The property is about REACHABILITY rather than names, so it is asserted over
 * every before→after pair rather than spot-checked.
 */
describe("revocationTopics tells the right people, over every transition", () => {
  const VIEWERS = [OWNER, "grantee", "stranger"] as const;

  it("never tells a viewer who still has access that the row is gone", () => {
    let checked = 0;
    for (const before of GRANT_OPTIONS) {
      for (const after of GRANT_OPTIONS) {
        const { gone, recheck } = revocationTopics(
          recipientTopics({ ownerUserId: OWNER, shares: before }),
          recipientTopics({ ownerUserId: OWNER, shares: after }),
        );
        for (const viewerId of VIEWERS) {
          for (const isAdmin of [false, true]) {
            const subscribed = topicsForViewer({ viewerId, isAdmin });
            const hadAccess = resolveSubshellAccess(viewerId, isAdmin, OWNER, before) !== "none";
            const hasAccess = resolveSubshellAccess(viewerId, isAdmin, OWNER, after) !== "none";
            const told = (topics: string[]) => subscribed.some((t) => topics.includes(t));
            const facts = { viewerId, isAdmin, before, after };

            // 1. The disclosure bug itself: a removal must never reach someone
            //    the row still belongs to.
            if (hasAccess) expect({ ...facts, gone: told(gone) }).toEqual({ ...facts, gone: false });

            // 2. And whoever DID lose it must hear something — either the
            //    authoritative removal or the ask that resolves to one.
            if (hadAccess && !hasAccess) {
              expect({ ...facts, told: told(gone) || told(recheck) }).toEqual({ ...facts, told: true });
            }

            // 3. Nothing is said to someone who never had it: they would be
            //    learning that an id they cannot see exists.
            if (!hadAccess) {
              expect({ ...facts, any: told(gone) || told(recheck) }).toEqual({ ...facts, any: false });
            }
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(GRANT_OPTIONS.length * GRANT_OPTIONS.length * VIEWERS.length * 2);
  });

  it("asks rather than asserts when the Everyone grant ends and named ones survive", () => {
    // `everyone` reaches the owner, who keeps the row, and every stranger, who
    // does not — one topic, two answers, so the frame cannot be an assertion.
    const { gone, recheck } = revocationTopics(
      recipientTopics({ ownerUserId: OWNER, shares: [{ granteeUserId: null, permission: "view" }] }),
      recipientTopics({ ownerUserId: OWNER, shares: [{ granteeUserId: "grantee", permission: "edit" }] }),
    );
    expect(recheck).toEqual([EVERYONE_TOPIC]);
    expect(gone).toEqual([]);
  });

  it("removes at once when one named grantee loses it — no ask needed", () => {
    // That viewer subscribes to their own topic and `everyone`, and neither
    // carries the row now, so nothing else could still be delivering it.
    const { gone, recheck } = revocationTopics(
      recipientTopics({
        ownerUserId: OWNER,
        shares: [{ granteeUserId: "grantee", permission: "view" }],
      }),
      recipientTopics({ ownerUserId: OWNER, shares: [] }),
    );
    expect(gone).toEqual([userTopic("grantee")]);
    expect(recheck).toEqual([]);
  });

  it("says nothing at all when a change widens access", () => {
    // The regression in one line: private → Everyone used to publish
    // `subshell-gone` to the owner's own topic.
    expect(
      revocationTopics(
        recipientTopics({ ownerUserId: OWNER, shares: [] }),
        recipientTopics({ ownerUserId: OWNER, shares: [{ granteeUserId: null, permission: "view" }] }),
      ),
    ).toEqual({ gone: [], recheck: [] });
  });
});
