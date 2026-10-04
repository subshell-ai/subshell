import { Elysia, t } from "elysia";
import { authGuard, HttpError, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { audit } from "@/services/audit.js";
import { backupPasswordChangeRequired, completeBackupPasswordRecovery } from "@/services/backup-admin-recovery.js";

export const backupRecoveryRoutes = new Elysia({ prefix: "/api/account/recovery" })
  .use(authGuard)
  .get("/", async ({ user, actor }) => {
    requireCookieActor(actor, "Recovery requires a browser session.");
    return { passwordChangeRequired: await backupPasswordChangeRequired(db, user.id) };
  })
  .post(
    "/password",
    async ({ user, actor, body }) => {
      requireCookieActor(actor, "Recovery requires a browser session.");
      if (!(await backupPasswordChangeRequired(db, user.id)))
        throw new HttpError(409, "No temporary password recovery is pending.");
      try {
        await completeBackupPasswordRecovery(db, user.id, body.currentPassword, body.newPassword);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Could not change the password.");
      }
      await audit({
        actorUserId: user.id,
        action: "backup.admin_recovery.complete",
        targetType: "user",
        targetId: user.id,
        metadataJson: null,
      });
      return { signInRequired: true };
    },
    {
      body: t.Object(
        {
          currentPassword: t.String({ maxLength: 4096, description: "Temporary password issued by the restore" }),
          newPassword: t.String({ maxLength: 4096, description: "Chosen replacement password" }),
        },
        { description: "Replace the temporary recovery password with a chosen one" },
      ),
    },
  );
