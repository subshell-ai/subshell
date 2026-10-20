import { cn } from "@internal/node-admin";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { ListLoadError } from "@/components/list-load-error";
import { useQuickAdd } from "@/components/quick-add";
import { AllSubshellsSection } from "@/components/sidebar/all-subshells-section";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { WorkspaceSidebarDrag, WorkspaceSidebarDropArea } from "@/components/sidebar/workspace-sidebar-drag";
import { WorkspaceBranch } from "@/components/sidebar/workspaces-section";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useSubshellLabels } from "@/hooks/use-subshell-labels";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { lastWorkspaceId } from "@/lib/current-workspace";
import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import { sidebarWorkspace } from "@/lib/sidebar-context";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";

const NEW_WORKSPACE = "__new_workspace__";

/** The workspace picker and the selected workspace's live, draggable pane rows. */
export function ActiveWorkspaceSection({ onQuickAdd, headerEnd }: { headerEnd?: ReactNode; onQuickAdd?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  const workspaces = useWorkspaces();
  const subshells = useSubshellsList();
  const focusedId = useWorkspaceFocusedId();
  const rows = workspaces.data ?? [];
  const active = sidebarWorkspace(rows, location.pathname, lastWorkspaceId());
  const memberIds = new Set(active?.panes?.map((pane) => pane.subshellId));
  const standaloneId = subshellIdFromPath(location.pathname);
  const standalone = !active && standaloneId ? subshells.data?.find((row) => row.id === standaloneId) : undefined;
  const labelsFor = useSubshellLabels();

  return (
    <WorkspaceSidebarDrag workspace={active}>
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex shrink-0 items-center gap-2 pb-2 text-detail text-muted-foreground">
          <span aria-hidden="true" className="w-3 border-t" />
          <span>Workspace</span>
          <span aria-hidden="true" className="flex-1 border-t" />
        </div>
        {workspaces.isLoading && <p className="px-3 text-detail text-muted-foreground">Loading workspaces…</p>}
        {workspaces.isError && (
          <ListLoadError message="Couldn’t load workspaces." retry={workspaces.refetch} busy={workspaces.isFetching} />
        )}
        <div className="flex min-w-0 items-center gap-2">
          <Select
            items={[
              ...rows.map((row) => ({ value: row.id, label: row.name })),
              { value: NEW_WORKSPACE, label: "New workspace" },
            ]}
            value={active?.id ?? null}
            onValueChange={(id) => {
              if (id === NEW_WORKSPACE) {
                quickAdd.openNewWorkspace();
                onQuickAdd?.();
                return;
              }
              if (id) void navigate({ to: "/workspaces/$id", params: { id } });
            }}
          >
            <SelectTrigger aria-label="Switch workspace" className="h-7 min-w-0 flex-1 px-2 py-0.5 text-detail">
              <SelectValue placeholder="Choose a workspace" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              {/* The divider earns its place only when the group above has rows;
                  with no workspaces there is nothing to separate. */}
              <SelectGroup className={cn("mt-1", rows.length > 0 && "border-t pt-1")}>
                <SelectItem value={NEW_WORKSPACE}>
                  <span className="flex items-center gap-2">
                    <Plus className="size-4" />
                    New workspace
                  </span>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {active && <WorkspaceActionsMenu key={active.id} workspace={active} />}
          {headerEnd}
        </div>
        <WorkspaceSidebarDropArea kind="add" className="flex max-h-[45%] shrink-0 flex-col">
          <div className="min-h-0 overflow-y-auto px-1 py-1">
            {active && (
              <WorkspaceActionsMenu workspace={active}>
                <WorkspaceBranch
                  workspace={active}
                  expanded
                  active={workspaceIdFromPath(location.pathname) === active.id || standaloneId !== null}
                  collapsible={false}
                  droppable={false}
                  forceOpen={false}
                  onToggle={() => {}}
                  focusedId={standaloneId ?? focusedId}
                  labelsFor={labelsFor}
                />
              </WorkspaceActionsMenu>
            )}
            {standalone && <SubshellRecentRow subshell={standalone} focused {...labelsFor(standalone)} />}
            {!workspaces.isLoading && !workspaces.isError && !active && !standalone && (
              <p className="px-3 text-detail text-muted-foreground">
                {workspaceIdFromPath(location.pathname)
                  ? "This workspace is no longer available."
                  : "Choose a workspace or create one to get started."}
              </p>
            )}
            {subshells.isError && (
              <ListLoadError message="Couldn’t load subshells." retry={subshells.refetch} busy={subshells.isFetching} />
            )}
          </div>
        </WorkspaceSidebarDropArea>
        <WorkspaceSidebarDropArea kind="remove" className="mt-2 flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 pb-2 text-detail text-muted-foreground">
            <span aria-hidden="true" className="w-3 border-t" />
            <span>Subshells</span>
            <span aria-hidden="true" className="flex-1 border-t" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <AllSubshellsSection workspaceId={active?.id} excludeIds={memberIds} onAction={onQuickAdd} />
          </div>
        </WorkspaceSidebarDropArea>
      </div>
    </WorkspaceSidebarDrag>
  );
}
