import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { installScriptRoute } from "@/api/install-script.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";

/**
 * `GET /install.sh` render rules (spec 2026-08-31 §8; the placeholder rule
 * added by spec 2026-10-08 §7, Task 14). The "Set up Subshell here" act runs
 * this exact script through a non-interactive exec and shows only a parsed
 * status verb, so ANY line the script prints must be safe to capture: the
 * 404 advice branch used to echo `--key $KEY`, which bash expands to the live
 * setup key at RUNTIME - invisible to the rendered-text tests, visible in the
 * captured output. It now prints the literal `--key <setup key>`: a copy-
 * paste template, never a value.
 *
 * The oracle rule stays: absent, unknown, spent, and expired keys render
 * byte-identically (the endpoint is not a setup-key oracle).
 */

const app = new Elysia().use(errorHandlerPlugin).use(installScriptRoute);
const repo = new NodeSetupKeysRepository(db);
const email = `install-${crypto.randomUUID()}@subshell.local`;
let userId = "";
const keyIds: string[] = [];

async function mkKey(ttlMs?: number): Promise<string> {
  const row = await repo.create(userId, ttlMs);
  keyIds.push(row.id);
  return row.key;
}

async function install(key?: string): Promise<Response> {
  const q = key ? `?setup_key=${encodeURIComponent(key)}` : "";
  return app.fetch(new Request(`http://localhost:3080/install.sh${q}`));
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("install-1"),
    role: "user",
  });
});

afterAll(async () => {
  for (const id of keyIds) await repo.deleteById(id, userId).catch(() => {});
  await deleteUserByEmailOrId({ email }).catch(() => {});
});

describe("install.sh 404 advice branch (spec 2026-10-08 §7)", () => {
  it("prints the literal `--key <setup key>` placeholder and never the key value", async () => {
    const key = await mkKey();
    const body = await (await install(key)).text();
    expect(body).toContain("--key <setup key>");
    // The runtime-expanding spelling is gone: bash would interpolate $KEY into
    // the advice line, and the "Set up Subshell here" parser captures that
    // line verbatim on a D that cannot fetch the node binary.
    expect(body).not.toContain("--key $KEY");
    // The key still appears EXACTLY once: the KEY= assignment the render doc
    // names as its only home.
    expect(body.split(key).length - 1).toBe(1);
  });
});

describe("install.sh failure rendering is one byte-identical answer (never an oracle)", () => {
  it("absent, unknown, spent, and expired keys render the same usage script", async () => {
    const absent = await (await install()).text();
    const unknown = await (await install(`nsk_${"x".repeat(32)}`)).text();
    const spentKey = await mkKey();
    await repo.consume(spentKey, crypto.randomUUID());
    const spent = await (await install(spentKey)).text();
    const expired = await (await install(await mkKey(-60_000))).text();
    expect(unknown).toBe(absent);
    expect(spent).toBe(absent);
    expect(expired).toBe(absent);
    expect(absent).toContain("exit 2");
  });
});
