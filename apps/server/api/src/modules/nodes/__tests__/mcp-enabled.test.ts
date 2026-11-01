import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import {
  decideMcpEnabled,
  getNodeMcpEnabled,
  pushSetMcpEnabled,
  reconcileMcpEnabled,
  setNodeMcpEnabled,
} from "@/modules/nodes/mcp-enabled.js";
import { resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/testing/api/auth-tables.js";
import { attachScriptedNode, ok } from "@/testing/scripted-node.js";

/**
 * The MCP switch's plane half: the decide table (pure, the ssh/preview
 * suites' pattern) and the act on a real row plus a scripted node (its seam:
 * no RPC mocks; the push travels the real `sendCommand` chain and lands in the
 * scripted wire, which is what proves the `set_mcp_enabled` frame parses
 * against the shipped parser).
 *
 * Two properties this suite exists to pin, and they pull in opposite
 * directions. Like its siblings, the plane is the sole writer: a reconcile
 * NEVER adopts, every disagreement ends with the row's value pushed down.
 * UNLIKE its siblings, silence reads ALLOWED: MCP wiring predates the switch,
 * so the pre-existing row and the never-pushed machine agree by default, and
 * only an explicit refusal splits them. Read the silence rule off the ssh
 * clone and every unpinned machine starts refusing.
 */

const nodes = new NodesRepository(db);
const nodeIds: string[] = [];
const emails: string[] = [];
let ownerId: string;

async function mkUser(): Promise<string> {
  const email = `mcp-on-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("mcp-pass-1"),
    role: "user",
  });
}

/** An enrolled agent node with no live socket. Every command on it fails offline. */
async function mkNode(): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: ownerId, name: `mcp-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  return id;
}

/** Audit rows for one target, newest last. */
async function auditFor(targetId: string): Promise<{ actorUserId: string | null; meta: unknown }[]> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("targetId", "=", targetId)
    .where("action", "=", "node.mcp_enabled.update")
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((r) => ({ actorUserId: r.actorUserId, meta: JSON.parse(r.metadataJson ?? "null") }));
}

/** Let the void-fired pushes land (the maintenance-apply posture). */
const settle = () => new Promise((r) => setTimeout(r, 25));

/**
 * Narrow a stamp read back from the row to the `string` the wire shape wants.
 * A null here IS a failure of the test's own subject, so it throws loudly
 * rather than asserting `!` over a value that could be null.
 */
function stamped(value: string | null | undefined): string {
  if (typeof value !== "string") throw new Error(`the row carries no mcp stamp: ${String(value)}`);
  return value;
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await mkUser();
});

afterAll(async () => {
  resetNodeRegistryForTests();
  for (const id of nodeIds) await nodes.deleteById(id);
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

/* ------------------ the pure table -------------------------- */

describe("decideMcpEnabled: silence allows, and the plane is still the only author", () => {
  const row = (mcpEnabled: 0 | 1, mcpEnabledAt: string | null) => ({ mcpEnabled, mcpEnabledAt });

  it("agreement is a noop: reported matches the row, either value", () => {
    expect(
      decideMcpEnabled(row(1, "2026-11-01T10:00:00.000Z"), { on: true, changedAt: "2026-11-01T10:00:00.000Z" }),
    ).toBe("noop");
    expect(
      decideMcpEnabled(row(0, "2026-11-01T10:00:00.000Z"), { on: false, changedAt: "2026-11-01T09:00:00.000Z" }),
    ).toBe("noop");
    // Differing stamps under an agreeing value are a relayed fact, not a
    // fight: there is no node-side writer to bargain with.
    expect(
      decideMcpEnabled(row(1, "2026-11-01T12:00:00.000Z"), { on: true, changedAt: "2026-11-01T09:00:00.000Z" }),
    ).toBe("noop");
  });

  it("silence means ALLOWED here: a default or on row agrees; a refused row pushes", () => {
    // THE inverted line, pinned. An absent mirror reads ALLOWED (the
    // pre-switch status quo), so a never-written or on row and a silent node
    // already answer alike. A row the owner refused faces a machine that would
    // wire anyway, and the row wins: that push is the repair.
    expect(decideMcpEnabled(row(1, null), undefined)).toBe("noop");
    expect(decideMcpEnabled(row(1, "2026-11-01T10:00:00.000Z"), undefined)).toBe("noop");
    expect(decideMcpEnabled(row(0, "2026-11-01T10:00:00.000Z"), undefined)).toBe("push-row");
  });

  it("disagreement pushes the row, in both directions, and never adopts: not even a NEWER report", () => {
    // With no node-side writer, even a future-dated report is just bytes the
    // row overwrites. This is the direction rule the ssh suite also pins.
    expect(
      decideMcpEnabled(row(0, "2026-11-01T10:00:00.000Z"), { on: true, changedAt: "2099-01-01T00:00:00.000Z" }),
    ).toBe("push-row");
    expect(
      decideMcpEnabled(row(1, "2026-11-01T10:00:00.000Z"), { on: false, changedAt: "2026-11-01T09:00:00.000Z" }),
    ).toBe("push-row");
  });

  it("the one disagreement with nothing to relay is a repair, not a silence", () => {
    // Row never written + a mirror saying OFF (a data dir hand-edited or
    // carried over): unlike SSH this disagreement is NOT inert, because the
    // mirror itself strips wiring. The row's default allowance wins with a
    // freshly minted stamp.
    expect(decideMcpEnabled(row(1, null), { on: false, changedAt: "2026-11-01T09:00:00.000Z" })).toBe("push-repair");
  });
});

/* ------------------ the act, on a real row -------------------------- */

describe("setNodeMcpEnabled: write, audit, push, one function", () => {
  it("writes the row, audits EXACTLY ONE row naming the actor, and pushes the stamped value", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    try {
      await setNodeMcpEnabled(nodeId, ownerId, false);
      const row = await nodes.findById(nodeId);
      expect(row?.mcpEnabled).toBe(0);
      expect(row?.mcpEnabledAt).not.toBeNull();
      await settle();
      // Exactly one audit row: the push adds nothing, and a second writer of
      // this act is precisely what the one-function shape exists to prevent.
      const rows = await auditFor(nodeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(ownerId);
      expect(rows[0].meta).toEqual({ on: false });
      // The push is the row's OWN bytes: the wire frame the shipped parser
      // accepted, the stored stamp included, not a re-stamped copy.
      expect(scripted.cmdsOf("set_mcp_enabled")).toEqual([
        { type: "set_mcp_enabled", on: false, changedAt: stamped(row?.mcpEnabledAt) },
      ]);
    } finally {
      scripted.detach();
    }
  });

  it("an ON flip lands too: the mirror is written as a value, not deleted", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    try {
      await setNodeMcpEnabled(nodeId, ownerId, true);
      const row = await nodes.findById(nodeId);
      expect(row?.mcpEnabled).toBe(1);
      expect(row?.mcpEnabledAt).not.toBeNull();
      await settle();
      expect(scripted.cmdsOf("set_mcp_enabled")).toEqual([
        { type: "set_mcp_enabled", on: true, changedAt: stamped(row?.mcpEnabledAt) },
      ]);
    } finally {
      scripted.detach();
    }
  });

  it("survives an offline node: the push is best-effort; the row already refuses", async () => {
    const nodeId = await mkNode();
    await expect(setNodeMcpEnabled(nodeId, ownerId, false)).resolves.toBeUndefined();
    expect((await nodes.findById(nodeId))?.mcpEnabled).toBe(0);
  });
});

/* ------------------ the default-allow read -------------------------- */

describe("getNodeMcpEnabled: the row is the record, read default-ALLOW", () => {
  it("a row that does not exist reads ON", async () => {
    await expect(getNodeMcpEnabled("no-such-node")).resolves.toBe(true);
  });

  it("a fresh row reads ON until someone flips it off", async () => {
    const nodeId = await mkNode();
    await expect(getNodeMcpEnabled(nodeId)).resolves.toBe(true);
    await setNodeMcpEnabled(nodeId, ownerId, false);
    await expect(getNodeMcpEnabled(nodeId)).resolves.toBe(false);
  });
});

/* ------------------ the hook body -------------------------- */

describe("reconcileMcpEnabled: decide, push the row, write nothing", () => {
  it("agreement pushes NOTHING: the steady state must not echo a command per beat", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    await setNodeMcpEnabled(nodeId, ownerId, false);
    const changedAt = stamped((await nodes.findById(nodeId))?.mcpEnabledAt);
    await settle();
    try {
      // The `ready` that follows the push carries exactly what was written.
      await reconcileMcpEnabled(nodeId, { on: false, changedAt });
      await settle();
      expect(scripted.countOf("set_mcp_enabled")).toBe(1); // only the flip's own push
    } finally {
      scripted.detach();
    }
  });

  it("disagreement pushes the ROW's value verbatim, and the row never moves", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    await setNodeMcpEnabled(nodeId, ownerId, false);
    const changedAt = stamped((await nodes.findById(nodeId))?.mcpEnabledAt);
    await settle();
    try {
      // The machine reports ALLOWED (its mirror corrupted, say) under an OFF
      // row: the answer is the row pushed down, never the report pulled up.
      await reconcileMcpEnabled(nodeId, { on: true, changedAt: "2026-11-01T13:00:00.000Z" });
      await settle();
      const pushes = scripted.cmdsOf("set_mcp_enabled");
      expect(pushes).toHaveLength(2);
      expect(pushes[1]).toEqual({ type: "set_mcp_enabled", on: false, changedAt }); // the row's bytes, stamp included
      expect((await nodes.findById(nodeId))?.mcpEnabledAt).toBe(changedAt); // unmoved: never adopted, never re-stamped
    } finally {
      scripted.detach();
    }
  });

  it("row OFF + node silent → the refusal is handed back, and the reconcile itself writes no row and no audit", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    await setNodeMcpEnabled(nodeId, ownerId, false);
    const changedAt = stamped((await nodes.findById(nodeId))?.mcpEnabledAt);
    await settle();
    const auditsBefore = (await auditFor(nodeId)).length;
    try {
      // A wiped data dir: no mirror, no stamp to offer, the row's refusal is
      // re-armed by the push (the decide table's same cell).
      await reconcileMcpEnabled(nodeId, undefined);
      await settle();
      expect(scripted.cmdsOf("set_mcp_enabled")).toEqual([
        { type: "set_mcp_enabled", on: false, changedAt },
        { type: "set_mcp_enabled", on: false, changedAt },
      ]);
      expect((await auditFor(nodeId)).length).toBe(auditsBefore); // pushes are not acts; only flips audit
    } finally {
      scripted.detach();
    }
  });

  it("a mirror refusing under an unwritten row repairs with a fresh stamp and leaves the row allowed", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_mcp_enabled: ok });
    try {
      // Nothing was ever written here, so there is no stamp to relay: the
      // repair mints one for the PUSH only (the row stays unwritten), and the
      // row's allowance is what travels.
      await reconcileMcpEnabled(nodeId, { on: false, changedAt: "2026-10-01T00:00:00.000Z" });
      await settle();
      const pushes = scripted.cmdsOf("set_mcp_enabled");
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toEqual({ type: "set_mcp_enabled", on: true, changedAt: expect.any(String) });
      const row = await nodes.findById(nodeId);
      expect(row?.mcpEnabled).toBe(1);
      expect(row?.mcpEnabledAt).toBeNull(); // the repair writes the machine, never the record
    } finally {
      scripted.detach();
    }
  });

  it("does nothing for a node that is not enrolled here", async () => {
    await expect(
      reconcileMcpEnabled("not-a-node", { on: false, changedAt: "2026-11-01T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------ `local` -------------------------- */

describe("`local` has no mirror to push to", () => {
  it("pushSetMcpEnabled is a NO-OP for local: resolves without a socket, where an agent would fail offline", async () => {
    // The proof is the contrast: `sendCommand` to a node with no live socket
    // rejects (the offline case above swallows exactly that). Local must
    // RESOLVE: its answer to the gate is the DB row, and there is no second
    // copy to tell.
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    await expect(
      pushSetMcpEnabled(LOCAL_NODE_ID, { on: false, changedAt: "2026-11-01T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("setNodeMcpEnabled works on local: row + audit, and the flip completes", async () => {
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    await setNodeMcpEnabled(LOCAL_NODE_ID, ownerId, false);
    expect((await nodes.findById(LOCAL_NODE_ID))?.mcpEnabled).toBe(0);
    // Restore the shipped default so no later expectation in this file's DB
    // inherits a closed server row (each test file gets its own database, and
    // audit-counting tests filter by targetId, so the extra audit rows here
    // are harmless by design).
    await setNodeMcpEnabled(LOCAL_NODE_ID, ownerId, true);
    expect((await nodes.findById(LOCAL_NODE_ID))?.mcpEnabled).toBe(1);
  });
});
