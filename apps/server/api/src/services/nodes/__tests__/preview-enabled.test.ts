import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import {
  decidePreviewEnabled,
  getVirtualDisplayEnabled,
  getWebPreviewsEnabled,
  pushSetPreviewEnabled,
  reconcilePreviewEnabled,
  setPreviewEnabled,
} from "@/services/nodes/preview-enabled.js";
import { attachScriptedNode, ok } from "@/test-helpers/scripted-node.js";

/**
 * The preview switch's plane half (pane-preview spec Task 3): the decide table
 * (pure, no DB, no socket, the ssh-enabled suite's pattern) and the hook
 * body with one real row and one scripted node (its seam: no RPC mocks, the
 * push travels the real `sendCommand` chain and lands in the scripted wire,
 * which is what proves the `set_preview_enabled` frame parses against the
 * shipped parser).
 *
 * The property this suite exists to pin is the DIRECTION, cloned verbatim from
 * the SSH twin: the plane is the sole writer, so a reconcile NEVER adopts.
 * Every disagreement ends with the row's value pushed down and the row itself
 * unmoved: that push IS the corruption repair.
 */

const nodes = new NodesRepository(db);
const nodeIds: string[] = [];
const emails: string[] = [];
let ownerId: string;

async function mkUser(): Promise<string> {
  const email = `preview-on-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("preview-pass-1"),
    role: "user",
  });
}

/** An enrolled agent node with no live socket. Every command on it fails offline. */
async function mkNode(): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: ownerId, name: `preview-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  return id;
}

/** Audit rows for one target, newest last. */
async function auditFor(targetId: string): Promise<{ actorUserId: string | null; meta: unknown }[]> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("targetId", "=", targetId)
    .where("action", "=", "node.preview_enabled.update")
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((r) => ({ actorUserId: r.actorUserId, meta: JSON.parse(r.metadataJson ?? "null") }));
}

/** Let the void-fired pushes land (the maintenance-apply posture). */
const settle = () => new Promise((r) => setTimeout(r, 25));

/**
 * Narrow a stamp read back from the row to the `string` the wire shape wants.
 * A null here IS a failure of the test's own subject, so it throws loudly
 * rather than asserting `!` over a value that could be null (or absent).
 */
function stamped(value: string | null | undefined): string {
  if (typeof value !== "string") throw new Error(`the row carries no preview stamp: ${String(value)}`);
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

describe("decidePreviewEnabled: the plane is authoritative, so stamps are never read", () => {
  const row = (webPreviewsEnabled: 0 | 1, previewEnabledAt: string | null) => ({
    webPreviewsEnabled,
    previewEnabledAt,
    virtualDisplayEnabled: webPreviewsEnabled,
  });

  it("agreement is a noop: reported matches the row, either value", () => {
    expect(
      decidePreviewEnabled(row(1, "2026-10-21T10:00:00.000Z"), { on: true, changedAt: "2026-10-21T10:00:00.000Z" }),
    ).toBe("noop");
    expect(
      decidePreviewEnabled(row(0, "2026-10-21T10:00:00.000Z"), { on: false, changedAt: "2026-10-21T09:00:00.000Z" }),
    ).toBe("noop");
    // Differing stamps under an agreeing value are a relayed fact, not a
    // fight: there is no node-side writer to bargain with.
    expect(
      decidePreviewEnabled(row(1, "2026-10-21T12:00:00.000Z"), { on: true, changedAt: "2026-10-21T09:00:00.000Z" }),
    ).toBe("noop");
  });

  it("silence means OFF here: row-off agrees (noop), row-on pushes", () => {
    // An absent mirror reads REFUSED on the machine, so a never-written or
    // off row and a silent node already answer alike; the row saying ON faces
    // a machine that refuses, and the row wins: that push is the repair.
    expect(decidePreviewEnabled(row(0, null), undefined)).toBe("noop");
    expect(decidePreviewEnabled(row(0, "2026-10-21T10:00:00.000Z"), undefined)).toBe("noop");
    expect(decidePreviewEnabled(row(1, "2026-10-21T10:00:00.000Z"), undefined)).toBe("push-plane");
  });

  it("disagreement pushes the row, in both directions, and never adopts: not even a NEWER report", () => {
    // With no node-side writer, even a future-dated report is just bytes the
    // row overwrites. This is the direction rule the task exists to pin.
    expect(
      decidePreviewEnabled(row(0, "2026-10-21T10:00:00.000Z"), { on: true, changedAt: "2099-01-01T00:00:00.000Z" }),
    ).toBe("push-plane");
    expect(
      decidePreviewEnabled(row(1, "2026-10-21T10:00:00.000Z"), { on: false, changedAt: "2026-10-21T09:00:00.000Z" }),
    ).toBe("push-plane");
  });

  it("the one disagreement with nothing to send is a noop, not an invented stamp", () => {
    // Row never written + a node mirror saying ON (a data dir carried across
    // from another plane, say): the row IS off, every plane-side gate reads
    // the row, so the disagreement is inert, and a push would have to mint a
    // `changedAt` for a write that never happened.
    expect(decidePreviewEnabled(row(0, null), { on: true, changedAt: "2026-10-21T09:00:00.000Z" })).toBe("noop");
  });
});

/* ------------------ the act, on a real row -------------------------- */

describe("setPreviewEnabled: write, audit, push, one function", () => {
  it("writes the row, audits EXACTLY ONE row naming the actor, and pushes the stamped value", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
    try {
      await setPreviewEnabled(nodeId, ownerId, true);
      const row = await nodes.findById(nodeId);
      expect(row?.webPreviewsEnabled).toBe(1);
      expect(row?.previewEnabledAt).not.toBeNull();
      await settle();
      // Exactly one audit row: the push adds nothing, and a second writer of
      // this act is precisely what the one-function shape exists to prevent.
      const rows = await auditFor(nodeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(ownerId);
      expect(rows[0].meta).toEqual({ on: true, feature: "web-previews" });
      // The push is the row's OWN bytes: the wire frame the shipped parser
      // accepted, the stored stamp included, not a re-stamped copy.
      expect(scripted.cmdsOf("set_preview_enabled")).toEqual([
        {
          type: "set_preview_enabled",
          displayProvider: "xvfb-x11vnc",
          displayProviders: ["xvfb-x11vnc"],
          on: true,
          webPreviewsOn: true,
          displayOn: false,
          changedAt: stamped(row?.previewEnabledAt),
        },
      ]);
    } finally {
      scripted.detach();
    }
  });

  it("an OFF flip lands too: the mirror is written as a value, not deleted", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
    try {
      await setPreviewEnabled(nodeId, ownerId, false);
      const row = await nodes.findById(nodeId);
      expect(row?.webPreviewsEnabled).toBe(0);
      expect(row?.previewEnabledAt).not.toBeNull();
      await settle();
      expect(scripted.cmdsOf("set_preview_enabled")).toEqual([
        {
          type: "set_preview_enabled",
          displayProvider: "xvfb-x11vnc",
          displayProviders: ["xvfb-x11vnc"],
          on: false,
          changedAt: stamped(row?.previewEnabledAt),
        },
      ]);
    } finally {
      scripted.detach();
    }
  });

  it("survives an offline node: the push is best-effort; the row already refuses", async () => {
    const nodeId = await mkNode();
    await expect(setPreviewEnabled(nodeId, ownerId, true)).resolves.toBeUndefined();
    expect((await nodes.findById(nodeId))?.webPreviewsEnabled).toBe(1);
  });
});

/* ------------------ the fail-closed read -------------------------- */

describe("getWebPreviewsEnabled: the row is the record, read fail-CLOSED", () => {
  it("a row that does not exist reads OFF", async () => {
    await expect(getWebPreviewsEnabled("no-such-node")).resolves.toBe(false);
  });

  it("a fresh row reads OFF until someone flips it", async () => {
    const nodeId = await mkNode();
    await expect(getWebPreviewsEnabled(nodeId)).resolves.toBe(false);
    await setPreviewEnabled(nodeId, ownerId, true);
    await expect(getWebPreviewsEnabled(nodeId)).resolves.toBe(true);
  });
});

/* ------------------ the hook body -------------------------- */

describe("reconcilePreviewEnabled: decide, push the row, write nothing", () => {
  it("agreement pushes NOTHING: the steady state must not echo a command per beat", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
    await setPreviewEnabled(nodeId, ownerId, true);
    const changedAt = stamped((await nodes.findById(nodeId))?.previewEnabledAt);
    await settle();
    try {
      // The `ready` that follows the push carries exactly what was written.
      await reconcilePreviewEnabled(nodeId, { on: true, webPreviewsOn: true, displayOn: false, changedAt });
      await settle();
      expect(scripted.countOf("set_preview_enabled")).toBe(1); // only the flip's own push
    } finally {
      scripted.detach();
    }
  });

  it("disagreement pushes the ROW's value verbatim, and the row never moves", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
    await setPreviewEnabled(nodeId, ownerId, true);
    const changedAt = stamped((await nodes.findById(nodeId))?.previewEnabledAt);
    await settle();
    try {
      // The machine reports REFUSED (its mirror corrupted, say) under an ON
      // row: the answer is the row pushed down, never the report pulled up.
      await reconcilePreviewEnabled(nodeId, { on: false, changedAt: "2026-10-21T13:00:00.000Z" });
      await settle();
      const pushes = scripted.cmdsOf("set_preview_enabled");
      expect(pushes).toHaveLength(2);
      expect(pushes[1]).toEqual({
        type: "set_preview_enabled",
        displayProvider: "xvfb-x11vnc",
        displayProviders: ["xvfb-x11vnc"],
        on: true,
        webPreviewsOn: true,
        displayOn: false,
        changedAt,
      }); // the row's bytes, stamp included
      expect((await nodes.findById(nodeId))?.previewEnabledAt).toBe(changedAt); // unmoved: never adopted, never re-stamped
    } finally {
      scripted.detach();
    }
  });

  it("row ON + node silent → push; and the reconcile itself writes no row and no audit", async () => {
    const nodeId = await mkNode();
    const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
    await setPreviewEnabled(nodeId, ownerId, true);
    const changedAt = stamped((await nodes.findById(nodeId))?.previewEnabledAt);
    await settle();
    const auditsBefore = (await auditFor(nodeId)).length;
    try {
      // A wiped data dir: no mirror, no stamp to offer, the row's value is
      // re-armed by the push (the decide table's same cell).
      await reconcilePreviewEnabled(nodeId, undefined);
      await settle();
      expect(scripted.cmdsOf("set_preview_enabled")).toEqual([
        {
          type: "set_preview_enabled",
          displayProvider: "xvfb-x11vnc",
          displayProviders: ["xvfb-x11vnc"],
          on: true,
          webPreviewsOn: true,
          displayOn: false,
          changedAt,
        },
        {
          type: "set_preview_enabled",
          displayProvider: "xvfb-x11vnc",
          displayProviders: ["xvfb-x11vnc"],
          on: true,
          webPreviewsOn: true,
          displayOn: false,
          changedAt,
        },
      ]);
      expect((await auditFor(nodeId)).length).toBe(auditsBefore); // pushes are not acts; only flips audit
    } finally {
      scripted.detach();
    }
  });

  it("a future-dated report does not outrank anything: there is nothing to outrank", async () => {
    // No adopt means nothing to clamp: an adopted stamp is the failure mode
    // clamps guard against, and preview never adopts one to begin with.
    const nodeId = await mkNode();
    await nodes.setPreviewEnabled(nodeId, { on: false, changedAt: "2026-10-21T10:00:00.000Z" });
    await reconcilePreviewEnabled(nodeId, { on: true, changedAt: "2099-01-01T00:00:00.000Z" });
    await settle();
    const row = await nodes.findById(nodeId);
    expect(row?.webPreviewsEnabled).toBe(0);
    expect(row?.previewEnabledAt).toBe("2026-10-21T10:00:00.000Z");
    expect(await auditFor(nodeId)).toHaveLength(0); // reconcile records nothing, ever
  });

  it("does nothing for a node that is not enrolled here", async () => {
    await expect(
      reconcilePreviewEnabled("not-a-node", { on: true, changedAt: "2026-10-21T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------ `local` -------------------------- */

describe("`local` has no mirror to push to", () => {
  it("pushSetPreviewEnabled is a NO-OP for local: resolves without a socket, where an agent would fail offline", async () => {
    // The proof is the contrast: `sendCommand` to a node with no live socket
    // rejects (the offline case above swallows exactly that). Local must
    // RESOLVE: its answer to the gate is the DB row, and there is no second
    // copy to tell.
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    await expect(
      pushSetPreviewEnabled(LOCAL_NODE_ID, { on: true, changedAt: "2026-10-21T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("setPreviewEnabled works on local: row + audit, and the flip completes", async () => {
    await nodes.create({ id: LOCAL_NODE_ID, ownerUserId: ownerId, name: "Server", kind: "local" }).catch(() => {});
    await setPreviewEnabled(LOCAL_NODE_ID, ownerId, true);
    expect((await nodes.findById(LOCAL_NODE_ID))?.webPreviewsEnabled).toBe(1);
    // Restore whatever the shared test DB had, so no later suite inherits a
    // server account with preview open (the switch ships OFF). The restore
    // goes through the service, so this test leaves two
    // node.preview_enabled.update audit rows on LOCAL_NODE_ID in THIS file's
    // DB - harmless by design: each test file gets its own database, and
    // audit-counting tests filter by targetId.
    await setPreviewEnabled(LOCAL_NODE_ID, ownerId, false);
    expect((await nodes.findById(LOCAL_NODE_ID))?.webPreviewsEnabled).toBe(0);
  });
});

it("keeps apps and display permissions independent across writes and reconciliation", async () => {
  const nodeId = await mkNode();
  const scripted = attachScriptedNode(nodeId, { set_preview_enabled: ok });
  try {
    await setPreviewEnabled(nodeId, ownerId, true, "display");
    expect(await getWebPreviewsEnabled(nodeId)).toBe(false);
    expect(await getVirtualDisplayEnabled(nodeId)).toBe(true);
    await settle();
    const displayOnly = scripted.cmdsOf("set_preview_enabled").at(-1);
    expect(displayOnly).toMatchObject({ on: true, webPreviewsOn: false, displayOn: true });
    const row = await nodes.findById(nodeId);
    await reconcilePreviewEnabled(nodeId, {
      on: true,
      webPreviewsOn: true,
      displayOn: false,
      changedAt: stamped(row?.previewEnabledAt),
    });
    await settle();
    expect(scripted.cmdsOf("set_preview_enabled").at(-1)).toEqual(displayOnly);
    await setPreviewEnabled(nodeId, ownerId, true);
    await setPreviewEnabled(nodeId, ownerId, false, "display");
    expect(await getWebPreviewsEnabled(nodeId)).toBe(true);
    expect(await getVirtualDisplayEnabled(nodeId)).toBe(false);
  } finally {
    scripted.detach();
  }
});

it("reconciles provider selection independently of the permissions", () => {
  const row = {
    webPreviewsEnabled: 0,
    virtualDisplayEnabled: 1,
    virtualDisplayProvider: "native-example",
    previewEnabledAt: "2026-10-25T00:00:00Z",
  };
  const reported = {
    on: true,
    webPreviewsOn: false,
    displayOn: true,
    changedAt: row.previewEnabledAt,
    displayProvider: "xvfb-x11vnc",
    displayProviders: ["xvfb-x11vnc"],
  };
  expect(decidePreviewEnabled(row, reported)).toBe("push-plane");
  expect(decidePreviewEnabled(row, { ...reported, displayProvider: "native-example" })).toBe("noop");
});
