import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/db/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { assertDirAllowedForTests } from "@/services/subshell-manager.service.js";
import { setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";

/**
 * The CONTROL PLANE's half of the launch gate.
 *
 * The node has its own copy and its own test (`commands-allowed-dirs.test.ts`
 * in apps/client/agent); this pins the server's, which is what produces the
 * explainable 403 before anything is spawned and what holds while a node has
 * yet to receive a push.
 *
 * Exercised through the real repository and the real `local` node row rather
 * than a fake, because the bug this feature has already had twice was a
 * MISMATCH between what is stored and what is compared — a fake repo returning
 * whatever the test hands it would have hidden both.
 */
describe("assertDirAllowed (control-plane launch gate)", () => {
  const repo = new NodeAllowedDirsRepository(db);
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(async () => {
    // Both migrators: `ensureLocalNode` seeds the system USER, which lives in
    // better-auth's tables, and nothing else in a service test creates them.
    await setupAuthTables();
    await ensureLocalNode(db);
    // realpath'd — rules are stored resolved, and the gate compares a resolved
    // candidate. On macOS the temp dir is behind /private.
    root = realpathSync(mkdtempSync(join(tmpdir(), "subshell-gate-")));
    allowed = join(root, "work");
    outside = join(root, "elsewhere");
    mkdirSync(join(allowed, "deep"), { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterAll(async () => {
    await repo.clearForNode(LOCAL_NODE_ID);
    rmSync(root, { recursive: true, force: true });
  });

  it("permits anything while the node has no rules", async () => {
    await repo.clearForNode(LOCAL_NODE_ID);
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, outside)).resolves.toBeUndefined();
  });

  it("permits a rule's own directory and anything beneath it", async () => {
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, allowed)).resolves.toBeUndefined();
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, join(allowed, "deep"))).resolves.toBeUndefined();
  });

  it("refuses a directory outside every rule, naming the rules in force", async () => {
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    // The message has to be actionable: a bare "forbidden" leaves the operator
    // guessing which directories they may use.
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, outside)).rejects.toThrow(allowed);
  });

  it("refuses an ANCESTOR of a rule — navigable is not launchable", async () => {
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, root)).rejects.toThrow();
  });

  it("refuses a sibling that merely shares the rule's name prefix", async () => {
    const sibling = `${allowed}-old`;
    mkdirSync(sibling, { recursive: true });
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, sibling)).rejects.toThrow();
  });

  it("agrees with a rule reached through a symlink, because rules are stored resolved", async () => {
    // The plane-divergence bug: a rule stored as typed never matched a
    // candidate that had been realpath'd, so the owner was refused the
    // directory they had just permitted. The route resolves at write time;
    // this asserts the gate accepts the result.
    const link = join(root, "link-to-work");
    symlinkSync(allowed, link);
    await repo.replaceForNode(LOCAL_NODE_ID, [realpathSync(link)]);
    await expect(assertDirAllowedForTests(LOCAL_NODE_ID, allowed)).resolves.toBeUndefined();
  });

  it("carries a 403, so the refusal surfaces as a client error not a server fault", async () => {
    await repo.replaceForNode(LOCAL_NODE_ID, [allowed]);
    await assertDirAllowedForTests(LOCAL_NODE_ID, outside).then(
      () => expect.unreachable("should have refused"),
      (err: unknown) => expect((err as { status?: number }).status).toBe(403),
    );
  });
});
