import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import { HttpError, requireAdmin } from "@/api/auth-guard.js";
import { audit } from "@/services/audit.js";
import { prepareBackupAdminRecovery } from "@/services/backup-admin-recovery.js";
import {
  backupDownloadJobStatus,
  cancelBackupDownloadJob,
  claimBackupDownload,
  startBackupDownloadJob,
} from "@/services/backup-download-jobs.js";
import {
  createRestoreStage,
  deleteRestoreStage,
  readRestoreStage,
  saveRestoreStage,
} from "@/services/backup-staging.js";
import { validateRestoreConfigOverrides } from "@/services/backups/index.js";
import { trustedTemporaryDirectory } from "@/services/backups/paths.js";
import { instanceBackupPaths } from "@/services/instance-backup-source.js";

const preparing = new Set<string>();

function recordAudit(actorUserId: string, action: string, targetId: string | null = null) {
  return audit({ actorUserId, action, targetType: "backup", targetId, metadataJson: null });
}

function downloadStream(path: string, cleanup: () => void, expiresAt: number): ReadableStream<Uint8Array> {
  const reader = Bun.file(path).stream().getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const timer = setTimeout(
    () => {
      controller.error(new Error("Backup download expired."));
      void reader.cancel().finally(cleanup);
    },
    Math.max(1, expiresAt - Date.now()),
  );
  const done = () => {
    clearTimeout(timer);
    cleanup();
  };
  return new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          controller.close();
          done();
        } else controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
        done();
      }
    },
    async cancel() {
      await reader.cancel();
      done();
    },
  });
}

export const backupsRoutes = new Elysia({ prefix: "/api/admin/backups" })
  .use(requireAdmin)
  .post(
    "/create",
    async ({ user, body }) => {
      try {
        const job = startBackupDownloadJob(user.id, body.password);
        await recordAudit(user.id, "backup.create", job.id);
        return job;
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Could not create backup.");
      }
    },
    { body: t.Object({ password: t.Optional(t.String({ maxLength: 4096 })) }) },
  )
  .get("/jobs/:id", ({ user, params }) => {
    try {
      return backupDownloadJobStatus(params.id, user.id);
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : "Backup unavailable.");
    }
  })
  .delete("/jobs/:id", ({ user, params }) => {
    try {
      cancelBackupDownloadJob(params.id, user.id);
      return { cancelled: true };
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : "Backup unavailable.");
    }
  })
  .get("/download/:id", ({ user, params }) => {
    try {
      const result = claimBackupDownload(params.id, user.id);
      return new Response(downloadStream(result.path, result.cleanup, result.expiresAt), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "Backup unavailable.");
    }
  })
  .post(
    "/inspect",
    async ({ user, body }) => {
      const dir = mkdtempSync(join(trustedTemporaryDirectory(), "subshell-backup-upload-"));
      chmodSync(dir, 0o700);
      try {
        const path = join(dir, body.archive.name.endsWith(".db") ? "archive.db" : "archive");
        await Bun.write(path, body.archive);
        chmodSync(path, 0o600);
        const record = await createRestoreStage(path, user.id, body.password);
        await recordAudit(user.id, "backup.inspect", record.id);
        return {
          id: record.id,
          expiresAt: record.expiresAt,
          manifest: record.stage.manifest,
          admins: record.stage.admins,
          legacyDatabaseOnly: record.stage.legacyDatabaseOnly,
        };
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid backup.");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { body: t.Object({ archive: t.File({ maxSize: "128m" }), password: t.Optional(t.String({ maxLength: 4096 })) }) },
  )
  .post(
    "/staged/:id",
    async ({ user, params, body }) => {
      if (preparing.has(params.id)) throw new HttpError(409, "Restore preparation is already in progress.");
      preparing.add(params.id);
      try {
        const record = readRestoreStage(params.id, user.id);
        if (record.prepared) throw new Error("This restore is already prepared. Upload again to change its options.");
        validateRestoreConfigOverrides(body.configOverrides ?? {});
        if (
          record.stage.legacyDatabaseOnly &&
          (body.mode !== "same-machine" || Object.keys(body.configOverrides ?? {}).length)
        )
          throw new Error(
            "Database-only snapshots cannot migrate instance state or change addresses. Use a full archive.",
          );
        if (body.recoveryUserId || body.temporaryPassword) {
          if (!body.recoveryUserId || !body.temporaryPassword)
            throw new Error("Select an admin and supply a temporary password.");
          await prepareBackupAdminRecovery(record.stage.databasePath, body.recoveryUserId, body.temporaryPassword);
        }
        record.choices = { mode: body.mode, configOverrides: body.configOverrides };
        record.recoveryUserId = body.recoveryUserId;
        record.destination = instanceBackupPaths();
        record.prepared = true;
        saveRestoreStage(record);
        await recordAudit(user.id, "backup.restore.stage", record.id);
        return { id: record.id, expiresAt: record.expiresAt, command: `subshell-server restore --staged ${record.id}` };
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Could not stage restore.");
      } finally {
        preparing.delete(params.id);
      }
    },
    {
      body: t.Object({
        mode: t.Union([t.Literal("same-machine"), t.Literal("migration")]),
        configOverrides: t.Optional(
          t.Object({
            baseUrl: t.Optional(t.String({ maxLength: 4096 })),
            host: t.Optional(t.String({ maxLength: 4096 })),
            port: t.Optional(t.String({ maxLength: 4096 })),
            trustedOrigins: t.Optional(t.String({ maxLength: 4096 })),
          }),
        ),
        recoveryUserId: t.Optional(t.String({ maxLength: 4096 })),
        temporaryPassword: t.Optional(t.String({ maxLength: 4096 })),
      }),
    },
  )
  .get("/staged/:id", ({ user, params }) => {
    try {
      const record = readRestoreStage(params.id, user.id);
      return { id: record.id, expiresAt: record.expiresAt, prepared: record.prepared ?? false };
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : "Restore not found.");
    }
  })
  .delete("/staged/:id", ({ user, params }) => {
    try {
      deleteRestoreStage(params.id, user.id);
      return { deleted: true };
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : "Restore not found.");
    }
  });
