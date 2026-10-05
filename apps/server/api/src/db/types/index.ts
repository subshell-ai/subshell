import type { AuditEventsTable } from "@/db/types/audit-events.db-types.js";
import type { AuthAttemptsTable } from "@/db/types/auth-attempts.db-types.js";
import type { AuthProviderTable } from "@/db/types/auth-providers.db-types.js";
import type { ChannelPostRecipientTable, ChannelPostTable } from "@/db/types/channel-posts.db-types.js";
import type { ChannelCursorTable, ChannelMemberTable, ChannelTable } from "@/db/types/channels.db-types.js";
import type { DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";
import type { FavoriteTable } from "@/db/types/favorites.db-types.js";
import type { IdentityTable } from "@/db/types/identities.db-types.js";
import type { NodeAllowedDirTable } from "@/db/types/node-allowed-dirs.db-types.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import type { NotificationSubscriptionTable } from "@/db/types/notification-subscriptions.db-types.js";
import type { PluginStateTable } from "@/db/types/plugin-state.db-types.js";
import type { PresetTable } from "@/db/types/presets.db-types.js";
import type { PromptStackItemTable, PromptStackTable } from "@/db/types/prompt-stacks.db-types.js";
import type { PromptTable } from "@/db/types/prompts.db-types.js";
import type { RecentPathTable } from "@/db/types/recent-paths.db-types.js";
import type { SettingTable } from "@/db/types/settings.db-types.js";
import type { SshConnectionTable } from "@/db/types/ssh-connections.db-types.js";
import type { SshGrantTable } from "@/db/types/ssh-grants.db-types.js";
import type { SshPaneTable } from "@/db/types/ssh-panes.db-types.js";
import type { SshRunTable } from "@/db/types/ssh-runs.db-types.js";
import type { SshRuntimeSessionTable } from "@/db/types/ssh-runtime-sessions.db-types.js";
import type { SshTerminalExecTable } from "@/db/types/ssh-terminal-execs.db-types.js";
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
  authProviders: AuthProviderTable;
  presets: PresetTable;
  prompts: PromptTable;
  promptStacks: PromptStackTable;
  promptStackItems: PromptStackItemTable;
  pluginState: PluginStateTable;
  subshells: SubshellTable;
  subshellShares: SubshellShareTable;
  nodes: NodeTable;
  nodeShares: NodeShareTable;
  nodeSetupKeys: NodeSetupKeyTable;
  nodeAllowedDirs: NodeAllowedDirTable;
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
  // SSH feature (Gate A contracts, SSH-SUPPORT.md §4). The five tables read
  // as a chain: connections own snapshots, grants bind panes to a revision
  // of one, runs record dispatched commands against a pinned revision,
  // panes mark managed terminals (control + generations), and terminal execs
  // track the pane-exec helper to recovery. The index choices live in the
  // migrations that create them; revocation and reconciliation queries are
  // documented there.
  sshConnections: SshConnectionTable;
  sshRuntimeSessions: SshRuntimeSessionTable;
  sshGrants: SshGrantTable;
  sshRuns: SshRunTable;
  sshPanes: SshPaneTable;
  sshTerminalExecs: SshTerminalExecTable;
}
