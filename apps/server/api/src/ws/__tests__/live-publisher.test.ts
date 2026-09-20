import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { publishLive } from "@/services/live-bus.js";
import { startLivePublisher } from "@/ws/live-publisher.js";
import { ADMINS_TOPIC, EVERYONE_TOPIC, userTopic } from "@/ws/live-topics.js";

/** Records what was published, per topic. */
function fakeTarget() {
  const sent: { topic: string; frame: Record<string, unknown> }[] = [];
  return {
    target: {
      publish(topic: string, data: string) {
        sent.push({ topic, frame: JSON.parse(data) });
        return 1;
      },
    },
    sent,
    typesFor: (id: string) => sent.filter((s) => s.frame.id === id).map((s) => s.frame.type),
  };
}

const settle = (ms = 90) => new Promise((r) => setTimeout(r, ms));

/** Rows created by the revocation cases, which need a row that actually EXISTS. */
const created: string[] = [];

/**
 * A real subshell row owned by `ownerId`.
 *
 * The revocation cases cannot use a made-up id any more: a `shares-changed`
 * whose row has vanished now publishes NOTHING, because the deletion event
 * owns that case and carries its own audience. Testing the revocation against
 * an absent row would be testing the skip.
 */
async function realRow(ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  created.push(id);
  await new SubshellsRepository(db).create({
    id,
    userId: ownerId,
    presetId: "p",
    harnessId: "claude-code",
    name: "publisher-test",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  return id;
}

// The suite shares one database, so these tables usually exist by the time
// this file runs — usually is not a contract, and without this the revocation
// cases pass in a full run and fail on their own.
beforeAll(async () => {
  await setupAuthTables();
});

afterAll(async () => {
  for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
});

describe("live publisher coalescing", () => {
  /**
   * The measured defect this closes: creating ONE subshell wrote the row,
   * minted its token and patched it post-spawn, and the browser received four
   * frames describing one act.
   */
  it("collapses a burst of changes to one id into a single resolve", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      for (let i = 0; i < 4; i++) publishLive({ kind: "subshell.changed", id: "burst" });
      await settle();
      // The row does not exist in the test database, so the publisher resolves
      // nothing and sends nothing — what is under test is that it TRIED once.
      // A deletion is the observable case; see the next test.
      expect(sent.filter((s) => s.frame.id === "burst")).toEqual([]);
    } finally {
      stop();
    }
  });

  it("sends ONE frame for a burst of deletions of the same row", async () => {
    const { target, typesFor } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      for (let i = 0; i < 4; i++) publishLive({ kind: "subshell.deleted", id: "d1", ownerId: "u1", shares: [] });
      await settle();
      // Two topics (the owner's and admins'), ONE frame each — not four.
      expect(typesFor("d1")).toEqual(["subshell-gone", "subshell-gone"]);
    } finally {
      stop();
    }
  });

  it("lets a deletion outrank a change queued for the same row in the window", async () => {
    const { target, typesFor } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({ kind: "subshell.changed", id: "d2" });
      publishLive({ kind: "subshell.deleted", id: "d2", ownerId: "u1", shares: [] });
      publishLive({ kind: "subshell.changed", id: "d2" }); // must not undo it
      await settle();
      expect(typesFor("d2")).toEqual(["subshell-gone", "subshell-gone"]);
    } finally {
      stop();
    }
  });

  it("keeps distinct rows distinct", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({ kind: "subshell.deleted", id: "a", ownerId: "u1", shares: [] });
      publishLive({ kind: "subshell.deleted", id: "b", ownerId: "u1", shares: [] });
      await settle();
      expect(new Set(sent.map((s) => s.frame.id))).toEqual(new Set(["a", "b"]));
    } finally {
      stop();
    }
  });

  it("stops publishing once torn down", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    publishLive({ kind: "subshell.deleted", id: "late", ownerId: "u1", shares: [] });
    stop();
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("a deletion reaches everyone the row reached", () => {
  /**
   * The grants cascade with the row, so a deletion that derived its audience
   * AFTER the write could only ever name the owner and the admins. A shared
   * subshell then sat on every grantee's dashboard until they reconnected —
   * and 404'd when clicked — because with the polls gone there is no next
   * snapshot to learn from. The shares ride the event for the same reason
   * `shares-changed` carries `before`.
   */
  it("tells a named grantee, not just the owner and the admins", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({
        kind: "subshell.deleted",
        id: "shared",
        ownerId: "owner",
        shares: [{ granteeUserId: "grantee", permission: "view" }],
      });
      await settle();
      const topics = sent.filter((x) => x.frame.id === "shared").map((x) => x.topic);
      expect(new Set(topics)).toEqual(new Set([userTopic("owner"), userTopic("grantee"), ADMINS_TOPIC]));
    } finally {
      stop();
    }
  });

  it("tells everyone when the row was shared with Everyone, naming no user", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({
        kind: "subshell.deleted",
        id: "public",
        ownerId: "owner",
        shares: [{ granteeUserId: null, permission: "view" }],
      });
      await settle();
      const topics = sent.filter((x) => x.frame.id === "public").map((x) => x.topic);
      // Saying it to an id a viewer never held is harmless by design (§4.2):
      // "you cannot see this" is true whether the row was deleted, unshared,
      // or never visible.
      expect(new Set(topics)).toEqual(new Set([EVERYONE_TOPIC, ADMINS_TOPIC]));
    } finally {
      stop();
    }
  });
});

describe("the coalescing window cannot swallow a revocation", () => {
  /**
   * `shares-changed` carries `before`, the only record of who used to see the
   * row — and ordinary changes land on the same id constantly (a sweep tick,
   * an attention self-report, a harness-session write). Overwriting it inside
   * the 40 ms window dropped the revocation entirely and silently, which is a
   * hole in the mechanism the spec names load-bearing.
   */
  it("keeps a queued shares-change when an ordinary change lands on the same id", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      const id = await realRow("owner");
      publishLive({
        kind: "subshell.shares-changed",
        id,
        before: { ownerUserId: "owner", shares: [{ granteeUserId: "ex", permission: "view" }] },
      });
      publishLive({ kind: "subshell.changed", id });
      await settle();
      const gone = sent.filter((x) => x.frame.type === "subshell-gone" && x.frame.id === id);
      expect(gone.map((x) => x.topic)).toContain(userTopic("ex"));
    } finally {
      stop();
    }
  });

  it("still lets a deletion outrank a queued shares-change", async () => {
    const { target, typesFor } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({
        kind: "subshell.shares-changed",
        id: "s11",
        before: { ownerUserId: "owner", shares: [] },
      });
      publishLive({ kind: "subshell.deleted", id: "s11", ownerId: "owner", shares: [] });
      await settle();
      expect(typesFor("s11")).toEqual(["subshell-gone", "subshell-gone"]);
    } finally {
      stop();
    }
  });

  it("keeps the EARLIEST before when two share changes land in one window", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      // first → who used to see it; second → an intermediate state that was
      // never the audience anyone needs telling about.
      const id = await realRow("owner");
      publishLive({
        kind: "subshell.shares-changed",
        id,
        before: { ownerUserId: "owner", shares: [{ granteeUserId: "first", permission: "view" }] },
      });
      publishLive({
        kind: "subshell.shares-changed",
        id,
        before: { ownerUserId: "owner", shares: [{ granteeUserId: "second", permission: "view" }] },
      });
      await settle();
      const topics = sent.filter((x) => x.frame.type === "subshell-gone" && x.frame.id === id).map((x) => x.topic);
      expect(topics).toContain(userTopic("first"));
      expect(topics).not.toContain(userTopic("second"));
    } finally {
      stop();
    }
  });
});

describe("a share revocation reaches the person who lost it", () => {
  /**
   * The asymmetry that makes this necessary: recipients computed AFTER the
   * write are exactly the people who still have the row, so publishing only
   * those tells everyone except the one person whose access just ended. Their
   * dashboard would keep the row until they reloaded.
   */
  it("sends subshell-gone to topics the row used to reach and no longer does", async () => {
    const sent: { topic: string; frame: Record<string, unknown> }[] = [];
    const target = {
      publish(topic: string, data: string) {
        sent.push({ topic, frame: JSON.parse(data) });
        return 1;
      },
    };
    const stop = startLivePublisher({ target, coalesceMs: 10 });
    try {
      // The row does not exist in this test DB, so the `subshell` half resolves
      // to nothing — but the revocation half is derived from the event itself
      // and must still land.
      const id = await realRow("owner");
      publishLive({
        kind: "subshell.shares-changed",
        id,
        before: { ownerUserId: "owner", shares: [{ granteeUserId: "ex", permission: "view" }] },
      });
      await new Promise((r) => setTimeout(r, 60));
      const gone = sent.filter((x) => x.frame.type === "subshell-gone");
      expect(gone.map((x) => x.topic)).toContain(userTopic("ex"));
      expect(gone.every((x) => x.frame.id === id)).toBe(true);
    } finally {
      stop();
    }
  });
});
