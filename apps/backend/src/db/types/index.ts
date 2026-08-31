import type { AuditEventsTable } from "@/db/types/audit-events.db-types.js";
import type { AuthAttemptsTable } from "@/db/types/auth-attempts.db-types.js";
import type { ChannelPostRecipientTable, ChannelPostTable } from "@/db/types/channel-posts.db-types.js";
import type { ChannelCursorTable, ChannelMemberTable, ChannelTable } from "@/db/types/channels.db-types.js";
import type { DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";
import type { FavoriteTable } from "@/db/types/favorites.db-types.js";
import type { HarnessPluginTable } from "@/db/types/harness-plugins.db-types.js";
import type { IdentityTable } from "@/db/types/identities.db-types.js";
import type { NotificationSubscriptionTable } from "@/db/types/notification-subscriptions.db-types.js";
import type { ProfileTable } from "@/db/types/profiles.db-types.js";
import type { RecentPathTable } from "@/db/types/recent-paths.db-types.js";
import type { SessionTable } from "@/db/types/sessions.db-types.js";
import type { SettingTable } from "@/db/types/settings.db-types.js";
import type { UserMetaTable } from "@/db/types/user-meta.db-types.js";
import type { WorkspacePaneTable } from "@/db/types/workspace-panes.db-types.js";
import type { WorkspaceTable } from "@/db/types/workspaces.db-types.js";

/**
 * Typed database schema for Kysely. Each table mirrors a migration.
 * (better-auth's own tables live outside this interface; better-auth manages
 * them separately.)
 */
export interface Database {
  authAttempts: AuthAttemptsTable;
  auditEvents: AuditEventsTable;
  harnessPlugins: HarnessPluginTable;
  profiles: ProfileTable;
  sessions: SessionTable;
  recentPaths: RecentPathTable;
  favorites: FavoriteTable;
  settings: SettingTable;
  userMeta: UserMetaTable;
  workspaces: WorkspaceTable;
  workspacePanes: WorkspacePaneTable;
  channels: ChannelTable;
  channelMembers: ChannelMemberTable;
  channelPosts: ChannelPostTable;
  channelPostRecipients: ChannelPostRecipientTable;
  channelCursors: ChannelCursorTable;
  identities: IdentityTable;
  notificationsSubscriptions: NotificationSubscriptionTable;
  deviceTokens: DeviceTokenTable;
}
