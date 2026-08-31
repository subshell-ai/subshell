import { Migrator } from "kysely/migration";
import { db } from "@/db/index.js";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as authAuditMigration from "@/db/migrations/0004-auth-audit.js";
import * as mountsMigration from "@/db/migrations/0005-mounts.js";
import * as workspacesMigration from "@/db/migrations/0006-workspaces.js";
import * as bookmarksMigration from "@/db/migrations/0007-bookmarks.js";
import * as dropWorkspaceDescriptionMigration from "@/db/migrations/0008-workspaces-drop-description.js";
import * as channelsMigration from "@/db/migrations/0009-channels.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as sessionNameLockedMigration from "@/db/migrations/0011-session-name-locked.js";
import * as favoritesMigration from "@/db/migrations/0012-favorites.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import * as sessionNotificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as devicePushTokensMigration from "@/db/migrations/0015-device-push-tokens.js";

/**
 * Runs all pending Kysely migrations against the app database.
 * Call once at server boot (before the HTTP listener starts).
 */
export async function runMigrations(): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          "0001-init": initMigration,
          "0002-operator-ux": operatorUxMigration,
          "0003-remote-ops": remoteOpsMigration,
          "0004-auth-audit": authAuditMigration,
          "0005-mounts": mountsMigration,
          "0006-workspaces": workspacesMigration,
          "0007-bookmarks": bookmarksMigration,
          "0008-workspaces-drop-description": dropWorkspaceDescriptionMigration,
          "0009-channels": channelsMigration,
          "0010-profile-default-flag": profileDefaultFlagMigration,
          "0011-session-name-locked": sessionNameLockedMigration,
          "0012-favorites": favoritesMigration,
          "0013-session-harness-id": sessionHarnessIdMigration,
          "0014-session-notifications": sessionNotificationsMigration,
          "0015-device-push-tokens": devicePushTokensMigration,
        };
      },
    },
  });

  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    throw error;
  }

  if (results) {
    for (const result of results) {
      if (result.status === "Success") {
        console.log(`migration ${result.migrationName} applied`);
      } else if (result.status === "Error") {
        throw new Error(`migration ${result.migrationName} failed`);
      }
    }
  }
}
