import type { ChannelPostsRepository } from "@/db/repositories/channel-posts.repository.js";
import type { ChannelsRepository } from "@/db/repositories/channels.repository.js";
import type { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import type { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import type { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import type { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import type { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import type { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import type { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import type { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import type { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { UsersRepository } from "@/db/repositories/users.repository.js";
import type { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import type { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";

/**
 * The repositories the request context wires into services (built in
 * `ApiContext.init`, see `src/lib/context.ts`). This mirrors exactly what the
 * context constructs — add an entry here (and in `ApiContext.init`) when a
 * service needs a new repository; remove it when the last consumer goes away.
 */
export interface Repositories {
  readonly sessions: SessionsRepository;
  readonly profiles: ProfilesRepository;
  readonly workspaces: WorkspacesRepository;
  readonly workspacePanes: WorkspacePanesRepository;
  readonly channels: ChannelsRepository;
  readonly channelPosts: ChannelPostsRepository;
  readonly identities: IdentitiesRepository;
  readonly recentPaths: RecentPathsRepository;
  readonly sessionShares: SessionSharesRepository;
  readonly userMeta: UserMetaRepository;
  readonly users: UsersRepository;
  readonly nodes: NodesRepository;
  readonly nodeShares: NodeSharesRepository;
  readonly nodeSetupKeys: NodeSetupKeysRepository;
  readonly nodeHarnesses: NodeHarnessesRepository;
}
