import { Elysia } from "elysia";
import { addWorkspacePaneRoute } from "@/api/workspaces/add-workspace-pane.route.js";
import { createWorkspaceRoute } from "@/api/workspaces/create-workspace.route.js";
import { deleteWorkspaceRoute } from "@/api/workspaces/delete-workspace.route.js";
import { getWorkspaceRoute } from "@/api/workspaces/get-workspace.route.js";
import { listWorkspacesRoute } from "@/api/workspaces/list-workspaces.route.js";
import { removeWorkspacePaneRoute } from "@/api/workspaces/remove-workspace-pane.route.js";
import { saveWorkspaceLayoutRoute } from "@/api/workspaces/save-workspace-layout.route.js";
import { updateWorkspaceRoute } from "@/api/workspaces/update-workspace.route.js";

/**
 * `/api/workspaces` — one Elysia instance per endpoint (mounted in the original
 * monolithic route's order); business logic lives in `WorkspacesService`
 * (`src/services/workspaces.service.ts`), reached by handlers via `ctx`.
 */
export const workspaceRoutes = new Elysia({ prefix: "/api/workspaces" })
  .use(createWorkspaceRoute)
  .use(listWorkspacesRoute)
  .use(getWorkspaceRoute)
  .use(updateWorkspaceRoute)
  .use(deleteWorkspaceRoute)
  .use(addWorkspacePaneRoute)
  .use(saveWorkspaceLayoutRoute)
  .use(removeWorkspacePaneRoute);
