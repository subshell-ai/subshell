import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { backupEncryptionPasswordProblem } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { HttpError, requireAdmin } from "@/api/auth-guard.js";
import { audit } from "@/services/audit.js";
import { prepareBackupAdminRecovery } from "@/services/backup-admin-recovery.js";
import { listLocalBackups } from "@/services/backup-catalog.js";
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
  type StageRecord,
  saveRestoreStage,
} from "@/services/backup-staging.js";
import { validateRestoreConfigOverrides } from "@/services/backups/index.js";
import { assertSafeHostPath, trustedTemporaryDirectory } from "@/services/backups/paths.js";
import { instanceBackupPaths } from "@/services/instance-backup-source.js";
import { restoreInspectionDefaults } from "@/services/restore-inspection.js";
import { preflightRestoreJob, startRestoreJob } from "@/services/restore-jobs.js";

function publicInspection(record: StageRecord) {
  return {
    id: record.id,
    expiresAt: record.expiresAt,
    manifest: record.stage.manifest,
    admins: record.stage.admins,
    legacyDatabaseOnly: record.stage.legacyDatabaseOnly,
    destination: instanceBackupPaths(),
    choices: restoreInspectionDefaults(record.stage, instanceBackupPaths()).choices,
  };
}

const preparing = new Set<string>();

function recordAudit(actorUserId: string, action: string, targetId: string | null = null) {
  return audit({ actorUserId, action, targetType: "backup", targetId, metadataJson: null });
}

const CreateBackupBodySchema = t.Object(
  {
    password: t.Optional(t.String({ maxLength: 4096, description: "Archive encryption password; omit for plaintext" })),
  },
  { description: "Options for a fresh full-instance backup" },
);

const InspectSavedBodySchema = t.Object(
  {
    path: t.String({ maxLength: 4096, description: "Saved archive path from GET /saved" }),
    password: t.Optional(t.String({ maxLength: 4096, description: "Decryption password for an encrypted archive" })),
  },
  { description: "Select a saved archive for restore staging" },
);

const InspectUploadBodySchema = t.Object(
  {
    archive: t.File({ maxSize: "128m", description: "Uploaded instance archive (.db, .tar.gz or .tar.gz.enc)" }),
    password: t.Optional(t.String({ maxLength: 4096, description: "Decryption password for an encrypted archive" })),
  },
  { description: "Stage a restore from an uploaded archive" },
);

const PrepareRestoreBodySchema = t.Object(
  {
    start: t.Optional(
      t.Boolean({ description: "Start the restored server after applying (default true; refused under a supervisor)" }),
    ),
    destination: t.Optional(
      t.Object(
        {
          databasePath: t.String({ maxLength: 4096, description: "Absolute destination database path" }),
          dataDir: t.String({ maxLength: 4096, description: "Absolute destination data directory" }),
          configPath: t.String({ maxLength: 4096, description: "Absolute destination config.env path" }),
        },
        { description: "Where the restored instance will live; defaults to this server's paths" },
      ),
    ),
    mode: t.Union([t.Literal("same-machine"), t.Literal("migration")], {
      description: "Whether this machine is the backup's original machine",
    }),
    configOverrides: t.Optional(
      t.Object(
        {
          baseUrl: t.Optional(
            t.String({ maxLength: 4096, description: "Public origin the restored server advertises" }),
          ),
          host: t.Optional(t.String({ maxLength: 4096, description: "Bind address for the restored server" })),
          port: t.Optional(t.String({ maxLength: 4096, description: "Listening port for the restored server" })),
          trustedOrigins: t.Optional(
            t.String({ maxLength: 4096, description: "Extra browser origins the restored instance trusts" }),
          ),
        },
        { description: "Address values rewritten in the restored config.env" },
      ),
    ),
    recoveryUserId: t.Optional(
      t.String({ maxLength: 4096, description: "Administrator to receive the temporary recovery password" }),
    ),
    temporaryPassword: t.Optional(
      t.String({ maxLength: 4096, description: "Temporary password set on the recovered administrator" }),
    ),
  },
  { description: "Prepare a staged restore: choices, destination and optional admin recovery" },
);

const ApplyRestoreBodySchema = t.Object(
  {
    confirmed: t.Boolean({ description: "Operator confirmed replacing this instance with the backup" }),
    interruptSessions: t.Optional(
      t.Boolean({ description: "Also terminate live sessions the restore cannot preserve" }),
    ),
  },
  { description: "Apply a prepared staged restore on this server" },
);

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
      if (body.password !== undefined) {
        const problem = backupEncryptionPasswordProblem(body.password);
        if (problem) throw new HttpError(400, problem);
      }
      try {
        const job = startBackupDownloadJob(user.id, body.password);
        await recordAudit(user.id, "backup.create", job.id);
        return job;
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Could not create backup.");
      }
    },
    { body: CreateBackupBodySchema },
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
  .get("/saved", async () => ({ backups: await listLocalBackups(instanceBackupPaths().dataDir) }))
  .post(
    "/inspect-saved",
    async ({ user, body }) => {
      const files = await listLocalBackups(instanceBackupPaths().dataDir);
      const selected = files.find((file) => file.path === body.path);
      if (!selected) throw new HttpError(400, "This saved backup is no longer available. Select another backup.");
      try {
        const record = await createRestoreStage(selected.path, user.id, body.password);
        await recordAudit(user.id, "backup.inspect", record.id);
        return publicInspection(record);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid backup.");
      }
    },
    { body: InspectSavedBodySchema },
  )
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
        return publicInspection(record);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid backup.");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { body: InspectUploadBodySchema },
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
        const destination = body.destination ?? instanceBackupPaths();
        for (const path of [destination.databasePath, destination.dataDir, destination.configPath]) {
          if (!path || !isAbsolute(path) || /[\r\n\0]/.test(path))
            throw new Error("Use absolute restore destination paths.");
          await assertSafeHostPath(path);
        }
        if (record.stage.legacyDatabaseOnly && body.destination)
          throw new Error("Database-only snapshots keep the current destination configuration.");
        if (body.recoveryUserId || body.temporaryPassword) {
          if (!body.recoveryUserId || !body.temporaryPassword)
            throw new Error("Select an admin and supply a temporary password.");
          await prepareBackupAdminRecovery(record.stage.databasePath, body.recoveryUserId, body.temporaryPassword);
        }
        record.choices = { mode: body.mode, configOverrides: body.configOverrides, start: body.start !== false };
        record.recoveryUserId = body.recoveryUserId;
        record.destination = destination;
        record.prepared = true;
        saveRestoreStage(record);
        await recordAudit(user.id, "backup.restore.stage", record.id);
        return {
          id: record.id,
          expiresAt: record.expiresAt,
          destination,
          command: `subshell-server restore --staged ${record.id}${body.start === false ? " --no-start" : ""}`,
        };
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Could not stage restore.");
      } finally {
        preparing.delete(params.id);
      }
    },
    { body: PrepareRestoreBodySchema },
  )
  .post("/staged/:id/preflight", async ({ user, params }) => {
    try {
      return await preflightRestoreJob(params.id, user.id);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Could not review restore.");
    }
  })
  .post(
    "/staged/:id/apply",
    async ({ user, params, body }) => {
      if (!body.confirmed) throw new HttpError(400, "Confirm replacement before restoring.");
      try {
        await recordAudit(user.id, "backup.restore.apply", params.id);
        return await startRestoreJob(params.id, user.id, body.interruptSessions === true);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Could not start restore.");
      }
    },
    { body: ApplyRestoreBodySchema },
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
