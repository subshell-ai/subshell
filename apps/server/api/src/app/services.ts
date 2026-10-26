import type { ChannelsService } from "@/modules/channels/channels.service.js";
import type { SubshellsService } from "@/modules/subshells/subshells.service.js";
import type { WorkspacesService } from "@/modules/workspaces/workspaces.service.js";

/**
 * The per-resource services built by `ApiContext` for one request (or for the
 * requestless singleton). Each entry owns one API resource's business logic.
 */
export interface Services {
  subshells: SubshellsService;
  workspaces: WorkspacesService;
  channels: ChannelsService;
}
