import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { subscribeLive } from "@/services/live-bus.js";
import { persistOutputFor, resetLiveViewersForTests } from "@/ws/viewers.js";

/**
 * {@link persistOutputFor} — the output heartbeat's second half.
 *
 * The dot that says "this pane is printing" is the `active` indicator, which
 * the client derives from `lastOutputAt` against the clock. Under the
 * event-driven feed a DB write nobody is told about reaches nobody: the row
 * cached in every open tab keeps its stale stamp, so an actively printing
 * pane read `idle` and never blinked (and for a subshell on an agent node,
 * where the 60s local mtime sweep deliberately never reaches, the stamp
 * moved ONLY while someone was attached and was announced NEVER). The write
 * is throttled to one per 2s per pane, which is what makes announcing it an
 * activity stamp rather than per-frame noise.
 */
const ids: string[] = [];

async function seedRow(): Promise<string> {
  const row = await getRequestlessContext().repos.subshells.create({
    id: crypto.randomUUID(),
    userId: "u-blink",
    presetId: "p-blink",
    harnessId: "shell",
    name: "blink",
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  ids.push(row.id);
  return row.id;
}

/** Polls until `cond` (the persist is fire-and-forget, so the write lands async). */
async function until(cond: () => boolean, maxMs = 1_000): Promise<boolean> {
  for (let waited = 0; waited < maxMs; waited += 20) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(() => resetLiveViewersForTests());
afterEach(() => resetLiveViewersForTests());

afterAll(async () => {
  if (ids.length > 0) {
    await db.deleteFrom("subshells").where("id", "in", ids).execute();
  }
});

describe("persistOutputFor announces the activity stamp", () => {
  it("publishes subshell.changed after the write lands, and the row carries the stamp", async () => {
    const id = await seedRow();
    const changed: string[] = [];
    const off = subscribeLive((e) => {
      if (e.kind === "subshell.changed") changed.push(e.id);
    });
    try {
      persistOutputFor(id);
      expect(await until(() => changed.includes(id))).toBe(true);
      const row = await db.selectFrom("subshells").select("lastOutputAt").where("id", "=", id).executeTakeFirst();
      expect(row?.lastOutputAt).not.toBeNull();
    } finally {
      off();
    }
  });

  it("the 2s throttle covers the announce: a second immediate persist adds no event", async () => {
    const id = await seedRow();
    const changed: string[] = [];
    const off = subscribeLive((e) => {
      if (e.kind === "subshell.changed") changed.push(e.id);
    });
    try {
      persistOutputFor(id);
      expect(await until(() => changed.length >= 1)).toBe(true);
      persistOutputFor(id); // inside the throttle window: neither write nor announce
      await new Promise((r) => setTimeout(r, 60));
      expect(changed.filter((c) => c === id)).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("the throttle is per pane: a printing neighbor is announced while this one is throttled", async () => {
    const [a, b] = [await seedRow(), await seedRow()];
    const changed: string[] = [];
    const off = subscribeLive((e) => {
      if (e.kind === "subshell.changed") changed.push(e.id);
    });
    try {
      persistOutputFor(a);
      expect(await until(() => changed.includes(a))).toBe(true);
      persistOutputFor(b); // a's throttle window must not silence b
      expect(await until(() => changed.includes(b))).toBe(true);
    } finally {
      off();
    }
  });
});
