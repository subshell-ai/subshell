import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { WorkspacesService } from "@/services/workspaces.service.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The pane add racing the workspace's OWN retirement (spec 2026-10-17, error
 * handling). The zero-panes auto-delete is not one transaction with the pane
 * removal — this codebase has no transaction helper — so an add whose
 * workspace retires between the existence check and the insert meets the
 * foreign-key refusal. That refusal means "the workspace you asked about is
 * gone", and it must answer the plain 404 the route already speaks, never a
 * 500 (review 2026-10-17: the add path's catch only spoke UNIQUE, so this
 * second race reached the error handler raw).
 *
 * The race window itself is too narrow to drive through HTTP, so these tests
 * stub the insert to fail the way the retiring row makes it fail. What they
 * pin is the catch's contract: the FK shape maps to the not-found answer, and
 * anything else still rethrows (a swallowed unrelated failure would read as a
 * filed pane that was never written). `WorkspacesError` is not exported, so
 * the assertion reads its shape — name, code, status — the way the route's
 * error handler does.
 */
describe("workspaces pane add vs the retirement race", () => {
  const ctx = getRequestlessContext();
  const userId = "u-wsretire";
  const workspaceId = crypto.randomUUID();
  const subshellId = crypto.randomUUID();
  let service: WorkspacesService;

  beforeAll(async () => {
    await runMigrations();
    service = new WorkspacesService({ db: ctx.db, log: getLogger(), repos: ctx.repos });
    await ctx.repos.workspaces.create({ id: workspaceId, userId, name: "Racing" });
    await ctx.repos.subshells.create({
      id: subshellId,
      userId,
      harnessId: "terminal",
      name: "racer",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
  });

  afterAll(async () => {
    await ctx.db.deleteFrom("workspacePanes").where("workspaceId", "=", workspaceId).execute();
    await ctx.db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    await ctx.repos.workspaces.delete(workspaceId);
  });

  /** Run `addWorkspacePane` with the insert replaced by a failing `error`. */
  async function addWithFailedInsert(error: Error): Promise<unknown> {
    const panesRepo = service.repos.workspacePanes;
    const original = panesRepo.create.bind(panesRepo);
    panesRepo.create = (async () => {
      throw error;
    }) as typeof panesRepo.create;
    try {
      return await service
        .addWorkspacePane(userId, workspaceId, subshellId)
        .then(() => null)
        .catch((err: unknown) => err);
    } finally {
      panesRepo.create = original;
    }
  }

  it("answers the retired-workspace FK with the plain 404, not a 500", async () => {
    const err = await addWithFailedInsert(new Error("FOREIGN KEY constraint failed"));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("WorkspacesError");
    expect(err).toMatchObject({ code: "not_found", status: 404 });
  });

  it("rethrows a failure that is not the retirement race", async () => {
    const err = await addWithFailedInsert(new Error("SQLITE_BUSY: database is locked"));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("SQLITE_BUSY");
    expect((err as Error).name).not.toBe("WorkspacesError");
  });
});
