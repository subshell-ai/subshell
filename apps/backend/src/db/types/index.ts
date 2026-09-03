import type { AuditEventsTable } from "@/db/types/audit-events.db-types.js";
import type { AuthAttemptsTable } from "@/db/types/auth-attempts.db-types.js";
import type { ChannelPostRecipientTable, ChannelPostTable } from "@/db/types/channel-posts.db-types.js";
import type { ChannelCursorTable, ChannelMemberTable, ChannelTable } from "@/db/types/channels.db-types.js";
import type { DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";
import type { FavoriteTable } from "@/db/types/favorites.db-types.js";
import type { HarnessPluginTable } from "@/db/types/harness-plugins.db-types.js";
import type { IdentityTable } from "@/db/types/identities.db-types.js";
import type { NodeHarnessTable } from "@/db/types/node-harnesses.db-types.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import type { NotificationSubscriptionTable } from "@/db/types/notification-subscriptions.db-types.js";
import type { ProfileTable } from "@/db/types/profiles.db-types.js";
import type { RecentPathTable } from "@/db/types/recent-paths.db-types.js";
import type { SettingTable } from "@/db/types/settings.db-types.js";
import type { SubshellShareTable } from "@/db/types/subshell-shares.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
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
  subshells: SubshellTable;
  subshellShares: SubshellShareTable;
  nodes: NodeTable;
  nodeShares: NodeShareTable;
  nodeSetupKeys: NodeSetupKeyTable;
  nodeHarnesses: NodeHarnessTable;
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
