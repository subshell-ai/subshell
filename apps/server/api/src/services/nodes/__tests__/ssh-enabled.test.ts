import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import {
  decideSshEnabled,
  pushSetSshEnabled,
  reconcileSshEnabled,
  setNodeSshEnabled,
} from "@/services/nodes/ssh-enabled.js";
import { attachScriptedNode, ok } from "@/test-helpers/scripted-node.js";

/**
 * The SSH gate's plane half (spec 2026-10-07 §4.3): the decide table — pure,
 * no DB, no socket (the `maintenance-decide.test.ts` pattern) — and the hook
 * body with one real row and one scripted node (the `maintenance-apply.test.ts`
 * pattern, and its seam: no RPC mocks, the push travels the real
 * `sendCommand` chain and lands in the scripted wire, which is what proves the
 * `set_ssh_enabled` frame parses against the shipped parser).
 *
 * The property this suite exists to pin is the DIRECTION: the plane is the
 * sole writer, so a reconcile NEVER adopts. Every disagreement ends with the
 * row's value pushed down and the row itself unmoved.
 */

const nodes = new NodesRepository(db);
const nodeIds: string[] = [];
const emails: string[] = [];
let ownerId: string;

async function mkUser(): Promise<string> {
  const email = `ssh-on-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("ssh-pass-1"),
    role: "user",
  });
}

/** An enrolled agent node with no live socket — every command on it fails offline. */
async function mkNode(): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: ownerId, name: `ssh-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  return id;
}

/** Audit rows for one target, newest last. */
async function auditFor(targetId: string): Promise<{ actorUserId: string | null; meta: unknown }[]> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("targetId", "=", targetId)
    .where("action", "=", "node.ssh_enabled.update")
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((r) => ({ actorUserId: r.actorUserId, meta: JSON.parse(r.metadataJson ?? "null") }));
}

/** Let the void-fired pushes land (the maintenance-apply posture). */
const settle = () => new Promise((r) => setTimeout(r, 25));

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

describe("decideSshEnabled — the plane is authoritative, so stamps are never read", () => {
  const row = (sshEnabled: 0 | 1, sshEnabledAt: string | null) => ({ sshEnabled, sshEnabledAt });

  it("agreement is a noop — reported matches the row, either value", () => {
    expect(
      decideSshEnabled(row(1, "2026-10-07T10:00:00.000Z"), { on: true, changedAt: "2026-10-07T10:00:00.000Z" }),
    ).toBe("noop");
    expect(
      decideSshEnabled(row(0, "2026-10-07T10:00:00.000Z"), { on: false, changedAt: "2026-10-07T09:00:00.000Z" }),
    ).toBe("noop");
    // Differing stamps under an agreeing value are a relayed fact, not a
    // fight — maintenance's tie-breaker has no job when nothing writes from
    // the node.
    expect(
      decideSshEnabled(row(1, "2026-10-07T12:00:00.000Z"), { on: true, changedAt: "2026-10-07T09:00:00.000Z" }),
    ).toBe("noop");
  });

  it("silence means OFF here: row-off agrees (noop), row-on pushes", () => {
    // An absent mirror reads REFUSED on the machine, so a never-written or
    // off row and a silent node already answer alike; the row saying ON faces
    // a machine that refuses, and the row wins — that push is the repair.
    expect(decideSshEnabled(row(0, null), undefined)).toBe("noop");
    expect(decideSshEnabled(row(0, "2026-10-07T10:00:00.000Z"), undefined)).toBe("noop");
    expect(decideSshEnabled(row(1, "2026-10-07T10:00:00.000Z"), undefined)).toBe("push-plane");
  });

  it("disagreement pushes the row, in both directions — and never adopts, not even a NEWER report", () => {
    // maintenance would adopt a newer node stamp; there is no node stamp here
    // that anyone wrote, so even a future-dated report is just bytes the row
    // overwrites.
    expect(
      decideSshEnabled(row(0, "2026-10-07T10:00:00.000Z"), { on: true, changedAt: "2099-01-01T00:00:00.000Z" }),
    ).toBe("push-plane");
    expect(
      decideSshEnabled(row(1, "2026-10-07T10:00:00.000Z"), { on: false, changedAt: "2026-10-07T09:00:00.000Z" }),
    ).toBe("push-plane");
  });

  it("the one disagreement with nothing to send is a noop, not an invented stamp", () => {
    // Row never written + a node mirror saying ON (data dir carried across
    // from another plane, say): the row IS off, every plane-side gate reads
    // the row, so the disagreement is inert — and a push would have to mint a
    // `changedAt` for a write that never happened.
    expect(decideSshEnabled(row(0, null), { on: true, changedAt: "2026-10-07T09:00:00.000Z" })).toBe("noop");
  });
});

/* ------------------ the act, on a real row -------------------------- */

describe("setNodeSshEnabled — write, audit, push, one function", () => {
  it("writes the row, audits EXACTLY ONE row naming the actor, and pushes the stamped value", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_ssh_enabled: ok });
    const changedAt = "2026-10-07T10:00:00.000Z";
    try {
      await setNodeSshEnabled({ nodeId, on: true, changedAt, actorUserId: ownerId });
      const row = await nodes.findById(nodeId);
      expect(row?.sshEnabled).toBe(1);
      expect(row?.sshEnabledAt).toBe(changedAt);
      await settle();
      // Exactly one audit row — the push adds nothing, and a second writer of
      // this act is precisely what the one-function shape exists to prevent.
      const rows = await auditFor(nodeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(ownerId);
      expect(rows[0].meta).toEqual({ on: true });
      // The push is the row's OWN bytes — the wire frame the shipped parser
      // accepted, not a re-stamped copy.
      expect(scripted.cmdsOf("set_ssh_enabled")).toEqual([{ type: "set_ssh_enabled", on: true, changedAt }]);
    } finally {
      scripted.detach();
    }
  });

  it("an OFF flip lands too — the mirror is written as a value, not deleted", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_ssh_enabled: ok });
    try {
      await setNodeSshEnabled({ nodeId, on: false, changedAt: "2026-10-07T11:00:00.000Z", actorUserId: ownerId });
      const row = await nodes.findById(nodeId);
      expect(row?.sshEnabled).toBe(0);
      expect(row?.sshEnabledAt).toBe("2026-10-07T11:00:00.000Z");
      await settle();
      expect(scripted.cmdsOf("set_ssh_enabled")).toEqual([
        { type: "set_ssh_enabled", on: false, changedAt: "2026-10-07T11:00:00.000Z" },
      ]);
    } finally {
      scripted.detach();
    }
  });

  it("survives an offline node — the push is best-effort; the row already refuses", async () => {
    const nodeId = await mkNode();
    await expect(
      setNodeSshEnabled({ nodeId, on: true, changedAt: "2026-10-07T12:00:00.000Z", actorUserId: ownerId }),
    ).resolves.toBeUndefined();
    expect((await nodes.findById(nodeId))?.sshEnabled).toBe(1);
  });
});

/* ------------------ the hook body -------------------------- */

describe("reconcileSshEnabled — decide, push the row, write nothing", () => {
  it("agreement pushes NOTHING — the steady state must not echo a command per beat", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_ssh_enabled: ok });
    const changedAt = "2026-10-07T10:00:00.000Z";
    await setNodeSshEnabled({ nodeId, on: true, changedAt, actorUserId: ownerId });
    await settle();
    try {
      // The `ready` that follows the push carries exactly what was written.
      await reconcileSshEnabled(nodeId, { on: true, changedAt });
      await settle();
      expect(scripted.countOf("set_ssh_enabled")).toBe(1); // only the flip's own push
    } finally {
      scripted.detach();
    }
  });

  it("disagreement pushes the ROW's value verbatim, and the row never moves", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_ssh_enabled: ok });
    const changedAt = "2026-10-07T10:00:00.000Z";
    await setNodeSshEnabled({ nodeId, on: true, changedAt, actorUserId: ownerId });
    await settle();
    try {
      // The machine reports REFUSED (its mirror corrupted, say) under an ON
      // row: the answer is the row pushed down — never the report pulled up.
      await reconcileSshEnabled(nodeId, { on: false, changedAt: "2026-10-07T13:00:00.000Z" });
      await settle();
      const pushes = scripted.cmdsOf("set_ssh_enabled");
      expect(pushes).toHaveLength(2);
      expect(pushes[1]).toEqual({ type: "set_ssh_enabled", on: true, changedAt }); // the row's bytes, stamp included
      expect((await nodes.findById(nodeId))?.sshEnabledAt).toBe(changedAt); // unmoved: never adopted, never re-stamped
    } finally {
      scripted.detach();
    }
  });

  it("row ON + node silent → push; and the reconcile itself writes no row and no audit", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_ssh_enabled: ok });
    const changedAt = "2026-10-07T10:00:00.000Z";
    await setNodeSshEnabled({ nodeId, on: true, changedAt, actorUserId: ownerId });
    await settle();
    const auditsBefore = (await auditFor(nodeId)).length;
    try {
      // A wiped data dir: no mirror, no stamp to offer, the row's value is
      // re-armed by the push (the maintenance-decide table's same cell).
      await reconcileSshEnabled(nodeId, undefined);
      await settle();
      expect(scripted.cmdsOf("set_ssh_enabled")).toEqual([
        { type: "set_ssh_enabled", on: true, changedAt },
        { type: "set_ssh_enabled", on: true, changedAt },
      ]);
      expect((await auditFor(nodeId)).length).toBe(auditsBefore); // pushes are not acts; only flips audit
    } finally {
      scripted.detach();
    }
  });

  it("a future-dated report does not outrank anything — there is nothing to outrank", async () => {
    // The maintenance suite's clamp test has no SSH twin because SSH has
    // nothing to clamp: an adopted stamp is the failure mode clamps guard
    // against, and SSH never adopts one to begin with.
    const nodeId = await mkNode();
    await nodes.setSshEnabled(nodeId, { on: false, changedAt: "2026-10-07T10:00:00.000Z" });
    await reconcileSshEnabled(nodeId, { on: true, changedAt: "2099-01-01T00:00:00.000Z" });
    await settle();
    const row = await nodes.findById(nodeId);
    expect(row?.sshEnabled).toBe(0);
    expect(row?.sshEnabledAt).toBe("2026-10-07T10:00:00.000Z");
    expect(await auditFor(nodeId)).toHaveLength(0); // reconcile records nothing, ever
  });

  it("does nothing for a node that is not enrolled here", async () => {
    await expect(reconcileSshEnabled("not-a-node", { on: true, changedAt: "2026-10-07T10:00:00.000Z" })).resolves.toBe(
      undefined,
    );
  });
});

/* ------------------ `local` -------------------------- */

describe("`local` has no mirror to push to", () => {
  it("pushSetSshEnabled is a NO-OP for local — resolves without a socket, where an agent would fail offline", async () => {
    // The proof is the contrast: `sendCommand` to a node with no live socket
    // rejects (the offline case above swallows exactly that). Local must
    // RESOLVE — its answer to the gate is the DB row, and there is no second
    // copy to tell.
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    await expect(
      pushSetSshEnabled(LOCAL_NODE_ID, { on: true, changedAt: "2026-10-07T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("setNodeSshEnabled works on local: row + audit, and the flip completes", async () => {
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    const changedAt = "2026-10-07T10:00:00.000Z";
    await setNodeSshEnabled({ nodeId: LOCAL_NODE_ID, on: true, changedAt, actorUserId: ownerId });
    expect((await nodes.findById(LOCAL_NODE_ID))?.sshEnabled).toBe(1);
    // Restore whatever the shared test DB had, so no later suite inherits a
    // server account with SSH open (spec §4.3: local ships OFF). The restore
    // goes through the service, so this test leaves two node.ssh_enabled.update
    // audit rows on LOCAL_NODE_ID in THIS file's DB - harmless by design: each
    // test file gets its own database, and audit-counting tests filter by
    // targetId.
    await setNodeSshEnabled({ nodeId: LOCAL_NODE_ID, on: false, changedAt, actorUserId: ownerId });
    expect((await nodes.findById(LOCAL_NODE_ID))?.sshEnabled).toBe(0);
  });
});
