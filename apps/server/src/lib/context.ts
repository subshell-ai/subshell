import type { Kysely } from "kysely";
import type { ILogLayer } from "loglayer";
import { db } from "@/db/index.js";
import { ChannelPostsRepository } from "@/db/repositories/channel-posts.repository.js";
import { ChannelsRepository } from "@/db/repositories/channels.repository.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import type { Repositories } from "@/db/repositories/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { WorkspacePanesRepository } from "@/db/repositories/workspace-panes.repository.js";
import { WorkspacesRepository } from "@/db/repositories/workspaces.repository.js";
import type { Database } from "@/db/types/index.js";
import { ChannelsService } from "@/services/channels.service.js";
import type { Services } from "@/services/index.js";
import { SubshellsService } from "@/services/subshells.service.js";
import { WorkspacesService } from "@/services/workspaces.service.js";
import { getLogger } from "@/utils/logger.js";

export type ApiContextParams = {
  /** The application database (a per-process temp file in tests, per `constants.ts`). */
  db: Kysely<Database>;
  /** Request-scoped logger, or the shared app logger for requestless use. */
  log: ILogLayer;
};

/**
 * Per-request dependency bundle: the database, a logger carrying the request
 * id, the repositories the services need, and the services themselves. Built
 * once per request by `contextPlugin` (exposed to handlers as `ctx`) — see
 * {@link getRequestlessContext} for use outside requests.
 */
export class ApiContext {
  readonly db: Kysely<Database>;
  readonly log: ILogLayer;
  /** Shared repo instances handed to every service (constructed once here). */
  readonly repos: Repositories;
  services: Services;

  constructor(params: ApiContextParams) {
    this.db = params.db;
    this.log = params.log;
    this.repos = {
      subshells: new SubshellsRepository(params.db),
      profiles: new ProfilesRepository(params.db),
      workspaces: new WorkspacesRepository(params.db),
      workspacePanes: new WorkspacePanesRepository(params.db),
      channels: new ChannelsRepository(params.db),
      channelPosts: new ChannelPostsRepository(params.db),
      identities: new IdentitiesRepository(params.db),
      recentPaths: new RecentPathsRepository(params.db),
      subshellShares: new SubshellSharesRepository(params.db),
      userMeta: new UserMetaRepository(params.db),
      users: new UsersRepository(params.db),
      nodes: new NodesRepository(params.db),
      nodeShares: new NodeSharesRepository(params.db),
      nodeSetupKeys: new NodeSetupKeysRepository(params.db),
      nodeHarnesses: new NodeHarnessesRepository(params.db),
      nodeAllowedDirs: new NodeAllowedDirsRepository(params.db),
    };
    this.services = {} as Services;
    this.init();
  }

  /** Builds the services over the shared params and links the sibling map. */
  private init() {
    const serviceParams = {
      log: this.log,
      db: this.db,
      repos: this.repos,
    };

    this.services = {
      subshells: new SubshellsService(serviceParams),
      workspaces: new WorkspacesService(serviceParams),
      channels: new ChannelsService(serviceParams),
    };

    for (const service of Object.values(this.services)) {
      service.withServices(this.services);
    }
  }
}

let requestlessContext: ApiContext | undefined;

/**
 * This is a singleton context that can be used outside of a request (ws
 * handlers, the MCP server bootstrap). It has nothing request-specific
 * attached to it — the log is the app logger, without a request id.
 */
export function getRequestlessContext(): ApiContext {
  if (!requestlessContext) {
    requestlessContext = new ApiContext({
      db,
      log: getLogger(),
    });
  }

  return requestlessContext;
}

/**
 * Resets the requestless singleton so a test can start from a clean context
 * (the code-style rule for singleton factories holding expensive resources).
 * @internal
 */
export function resetRequestlessContext(): void {
  requestlessContext = undefined;
}
