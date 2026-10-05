import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TmuxRunner } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { nudgeSubshell, setNudgeTransportForTests } from "@/services/channels/nudge.js";
import { DENY_EVERYTHING_SSH_POLICY, setSshPolicyForTests } from "@/services/pane-ssh-gate.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";

/**
 * Review M2: a nudge is REST-initiated keystrokes straight to a pane, and it
 * must never bypass the managed-SSH input seam. `nudgeSubshell` refuses a
 * managed pane at the plane (the ssh_panes row is the whole test, no policy
 * call - automated keystrokes to an SSH terminal ride ONLY the
 * generation-stamped gated input path), and the ordinary path is untouched.
 */

interface FakeTransport {
  input: { socket: string; target: string; text: string }[];
  enter: { socket: string; target: string }[];
}

function fakeTransport(): FakeTransport & { asTmux: TmuxRunner } {
  const t: FakeTransport = { input: [], enter: [] };
  return {
    ...t,
    input: t.input,
    enter: t.enter,
    asTmux: {
      sendInput: async (socket: string, target: string, text: string) => {
        t.input.push({ socket, target, text });
      },
      pressEnter: async (socket: string, target: string) => {
        t.enter.push({ socket, target });
      },
    } as unknown as TmuxRunner,
  };
}

describe("nudgeSubshell SSH refusal (review M2)", () => {
  const ownerEmail = `nudgessh-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let node: string;

  async function seedPane(name: string, managed: boolean): Promise<string> {
    const id = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      harnessId: "terminal",
      name,
      workingDir: "/tmp",
      tmuxSocket: `sock-${id.slice(0, 8)}`,
      nodeId: node,
      status: "running",
      alive: 1,
      startedAt: "2026-10-04T00:00:00.000Z",
    } as never);
    if (managed) {
      const connId = crypto.randomUUID();
      await db
        .insertInto("sshConnections")
        .values({
          id: connId,
          userId: ownerId,
          nodeId: node,
          displayName: name,
          configSnapshot: "{}",
          remoteDir: null,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto("sshPanes")
        .values({
          subshellId: id,
          connectionId: connId,
          connectionRevision: 1,
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          controlOwner: "agent",
          controlGeneration: 1,
          logGeneration: 1,
          createdAt: new Date().toISOString(),
        })
        .execute();
    }
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword("x"),
      name: "Nudge SSH",
      role: "user",
    });
    node = crypto.randomUUID();
    await new NodesRepository(db).create({
      id: node,
      ownerUserId: ownerId,
      name: `n-${node.slice(0, 8)}`,
      kind: "agent",
    });
  });

  afterAll(async () => {
    setNudgeTransportForTests(null);
    setSshPolicyForTests(null);
    await db.deleteFrom("sshPanes").execute();
    await db.deleteFrom("sshConnections").execute();
    await db.deleteFrom("subshells").where("userId", "=", ownerId).execute();
    await deleteUserByEmailOrId(ownerEmail);
  });

  it("an ordinary pane receives the nudge line and the Enter (transport unchanged)", async () => {
    const pane = await seedPane("nudge-ordinary", false);
    const t = fakeTransport();
    setNudgeTransportForTests(t.asTmux);
    await nudgeSubshell(`sock-${pane.slice(0, 8)}`, pane, "[#chan] new post", { submit: true });
    expect(t.input).toEqual([{ socket: `sock-${pane.slice(0, 8)}`, target: pane, text: "[#chan] new post" }]);
    expect(t.enter).toEqual([{ socket: `sock-${pane.slice(0, 8)}`, target: pane }]);
  });

  it("a MANAGED pane receives NO input and NO enter (review M2: no bypass of the gated seam)", async () => {
    const pane = await seedPane("nudge-managed", true);
    const t = fakeTransport();
    setNudgeTransportForTests(t.asTmux);
    await nudgeSubshell(`sock-${pane.slice(0, 8)}`, pane, "[#chan] new post", { submit: true });
    expect(t.input).toEqual([]);
    expect(t.enter).toEqual([]);
  });

  it("the managed refusal is UNCONDITIONAL: the policy is never consulted", async () => {
    const pane = await seedPane("nudge-managed-nopolicy", true);
    let consulted = 0;
    setSshPolicyForTests({
      ...DENY_EVERYTHING_SSH_POLICY,
      gatePaneSurface: async () => {
        consulted += 1;
        return { allow: true };
      },
    });
    const t = fakeTransport();
    setNudgeTransportForTests(t.asTmux);
    await nudgeSubshell(`sock-${pane.slice(0, 8)}`, pane, "[#chan] new post", { submit: false });
    expect(t.input).toEqual([]);
    expect(consulted).toBe(0); // the refusal is the ssh_panes row's existence, not a decision
  });

  it("an inert (no-submit) nudge to an ordinary pane still lands, Enter-less", async () => {
    const pane = await seedPane("nudge-ordinary-inert", false);
    const t = fakeTransport();
    setNudgeTransportForTests(t.asTmux);
    await nudgeSubshell(`sock-${pane.slice(0, 8)}`, pane, "[subshell] new post in #chan");
    expect(t.input.length).toBe(1);
    expect(t.enter).toEqual([]);
  });
});
