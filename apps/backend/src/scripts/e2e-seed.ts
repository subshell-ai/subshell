import { hashPassword } from "better-auth/crypto";
import { DATABASE_PATH } from "@/constants.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";

/**
 * Seed/inspector for the two-process cross-subshell e2e test (plan T13).
 *
 * Runs as a STANDALONE process against the same file database as the spawned
 * backend (`DATABASE_PATH=<file> NODE_ENV=development bun src/scripts/e2e-seed.ts <mode>`)
 * — it shares no state with the in-memory test process, which is the point:
 * everything the test proves crosses a real process boundary. The script
 * produces DATA only; all assertions live in the test.
 *
 * Modes:
 * - `create`     seed user + profile + two subshell rows, print their tokens as JSON
 * - `ciphertext` JSON report of the stored `e2e` posts and a plaintext-marker
 *                byte-scan of the database files (incl. the WAL)
 */

async function prepareDb(): Promise<void> {
  await runMigrations();
  await runAuthMigrations();
}

/** Print `{ userId, profileId, subshells: [{id, token}] }` for two fake subshells. */
async function create(): Promise<void> {
  await prepareDb();
  const users = new UsersRepository(db);
  const userId = await users.createUser({
    email: `e2e-${crypto.randomUUID().slice(0, 8)}@subshell.local`,
    passwordHash: await hashPassword("e2e-pass-1234"),
    role: "admin",
  });
  const profileId = (
    await new ProfilesRepository(db).create({
      id: crypto.randomUUID(),
      userId,
      harnessId: "e2e-fake",
      name: "e2e-profile",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    })
  ).id;
  const subshells = new SubshellsRepository(db);
  const out: { id: string; token: string }[] = [];
  for (const name of ["e2e-A", "e2e-B"]) {
    const id = crypto.randomUUID();
    // No tmuxSocket: reconcile treats a socket-less row as absent but NEVER
    // revokes its token (revocation lives in the has-socket crash branch), so
    // the fake subshell keeps a valid credential for the test's lifetime.
    await subshells.create({
      id,
      userId,
      profileId,
      harnessId: "e2e-fake",
      name,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    out.push({ id, token: await issueSubshellToken(id, userId) });
  }
  process.stdout.write(`${JSON.stringify({ userId, profileId, subshells: out })}\n`);
}

/**
 * Storage report for the `e2e` channel: envelope count/shape plus a raw-byte
 * scan for the given marker across the SQLite file and its WAL/SHM siblings
 * (recent writes may not be checkpointed into the main file yet).
 */
async function ciphertext(marker: string): Promise<void> {
  await prepareDb();
  const rows = await db
    .selectFrom("channelPosts")
    .select("envelope")
    .where("channelId", "in", (qb) => qb.selectFrom("channels").select("id").where("name", "=", "e2e"))
    .execute();
  const envelopesValid = rows.every((r) => (JSON.parse(r.envelope) as { ciphertext?: string }).ciphertext);

  const needle = Buffer.from(marker);
  let leaked = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = Bun.file(`${DATABASE_PATH}${suffix}`);
    if (!(await f.exists())) continue;
    if (Buffer.from(await f.arrayBuffer()).includes(needle)) leaked = true;
  }
  process.stdout.write(`${JSON.stringify({ envelopeCount: rows.length, envelopesValid, leaked })}\n`);
}

const mode = process.argv[2];
switch (mode) {
  case "create":
    await create();
    break;
  case "ciphertext":
    if (!process.argv[3]) throw new Error("ciphertext mode needs the marker string to scan for");
    await ciphertext(process.argv[3]);
    break;
  default:
    throw new Error(`unknown mode: ${mode ?? "(none)"} (want create|ciphertext)`);
}
