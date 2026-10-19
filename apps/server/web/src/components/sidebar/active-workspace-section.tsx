import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { ListLoadError } from "@/components/list-load-error";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { WorkspaceBranch } from "@/components/sidebar/workspaces-section";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useSubshellLabels } from "@/hooks/use-subshell-labels";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { lastWorkspaceId } from "@/lib/current-workspace";
import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import { sidebarWorkspace } from "@/lib/sidebar-context";
import { needsAttention } from "@/lib/subshell-node-groups";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";

const NEW_WORKSPACE = "__new_workspace__";

/** The workspace picker and the selected workspace's live, draggable pane rows. */
export function ActiveWorkspaceSection({ onQuickAdd }: { onQuickAdd?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  const workspaces = useWorkspaces();
  const subshells = useSubshellsList();
  const focusedId = useWorkspaceFocusedId();
  const rows = workspaces.data ?? [];
  const active = sidebarWorkspace(rows, location.pathname, lastWorkspaceId());
  const memberIds = new Set(active?.panes?.map((pane) => pane.subshellId));
  const elsewhere = needsAttention(subshells.data ?? []).filter((row) => !memberIds.has(row.id));
  const standaloneId = subshellIdFromPath(location.pathname);
  const standalone = !active && standaloneId ? subshells.data?.find((row) => row.id === standaloneId) : undefined;
  const labelsFor = useSubshellLabels();

  return (
    <div className="flex flex-col gap-3">
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
          <SelectTrigger aria-label="Switch workspace" className="min-w-0 flex-1">
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
            <SelectGroup className="mt-1 border-t pt-1">
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
      </div>
      {active && (
        <WorkspaceActionsMenu workspace={active}>
          <WorkspaceBranch
            workspace={active}
            expanded
            active={workspaceIdFromPath(location.pathname) === active.id || standaloneId !== null}
            collapsible={false}
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
      {elsewhere.length > 0 && (
        <Link to="/subshells" className="mt-4 px-3 py-2 text-detail text-warning">
          {elsewhere.length} need attention elsewhere
        </Link>
      )}
    </div>
  );
}
