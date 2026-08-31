import type { ChannelsService } from "@/services/channels.service.js";
import type { SessionsService } from "@/services/sessions.service.js";
import type { WorkspacesService } from "@/services/workspaces.service.js";

/**
 * The per-resource services built by `ApiContext` for one request (or for the
 * requestless singleton). Each entry owns one API resource's business logic.
 */
export interface Services {
  sessions: SessionsService;
  workspaces: WorkspacesService;
  channels: ChannelsService;
}
