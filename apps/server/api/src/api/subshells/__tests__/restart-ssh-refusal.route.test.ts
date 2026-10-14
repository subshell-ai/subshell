import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";

/**
 * An ssh pane refuses `POST /:id/restart` with a named 409 (decision 7): its
 * "session" lives on the far end of a socket, so a restart would spawn a NEW
 * ssh process the human never asked to reconnect — the launcher is the way
 * back in. The refusal is keyed to the `subshells.ssh` column (the kind fact,
 * migration 0048), asked AFTER the visibility gate (a stranger still gets the
 * 404) and BEFORE anything the restart path writes.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const subshells = new SubshellsRepository(db);

const pw = "ssh-nores-1";
const ownerEmail = `sshnr-owner-${crypto.randomUUID()}@subshell.local`;
const strangerEmail = `sshnr-str-${crypto.randomUUID()}@subshell.local`;
let ownerCookie: string;
let strangerCookie: string;
let ownerId: string;
const created: string[] = [];

function seedSshRow(id: string, ssh: string | null, nodeId = LOCAL_NODE_ID): Promise<unknown> {
  created.push(id);
  return subshells.create({
    id,
    userId: ownerId,
    harnessId: "ssh",
    name: "ssh pane",
    workingDir: tmpdir(),
    tmuxSocket: null,
    status: "terminated",
    alive: 0,
    nodeId,
    ssh,
  });
}

function restart(id: string, cookie: string) {
  return app.fetch(
    new Request(`http://localhost:3099/api/subshells/${id}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
    }),
  );
}

beforeAll(async () => {
  await setupAuthTables();
  const mk = async (email: string) =>
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  ownerId = await mk(ownerEmail);
  await mk(strangerEmail);
  ownerCookie = await signIn(ownerEmail, pw);
  strangerCookie = await signIn(strangerEmail, pw);
});

afterAll(async () => {
  for (const id of created) await subshells.delete(id).catch(() => {});
  for (const mail of [ownerEmail, strangerEmail]) await deleteUserByEmailOrId(mail);
});

describe("ssh panes refuse restart (decision 7)", () => {
  it("a row whose snapshot column is set is refused with the named 409 before anything restarts", async () => {
    const id = crypto.randomUUID();
    await seedSshRow(id, '{"host":"example.test"}');

    const res = await restart(id, ownerCookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe(BackendErrorCodes.SSH_NO_RESTART);
    expect(body.message.toLowerCase()).toContain("launch"); // the remedy: reconnect from the launcher
    const row = await subshells.findById(id);
    expect(row?.status).toBe("terminated"); // nothing moved
  });

  it("a stranger gets the ordinary 404 on an ssh row (the gate runs first; the refusal is no oracle)", async () => {
    const id = crypto.randomUUID();
    await seedSshRow(id, '{"host":"example.test"}');
    expect((await restart(id, strangerCookie)).status).toBe(404);
  });

  it("a non-ssh row is NOT refused by this rule (the offline node still answers its own NODE_OFFLINE 409)", async () => {
    const id = crypto.randomUUID();
    await seedSshRow(id, null, "node-gone-offline");
    const res = await restart(id, ownerCookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.NODE_OFFLINE);
  });
});
