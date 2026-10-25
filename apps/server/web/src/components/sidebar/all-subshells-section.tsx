import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesCombined, Plus } from "lucide-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { ListLoadError } from "@/components/list-load-error";
import { useQuickAdd } from "@/components/quick-add";
import { SidebarGroupHeading } from "@/components/sidebar/sidebar-group-heading";
import { SubshellTreeRow } from "@/components/sidebar/subshell-tree-row";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/hooks/use-nodes";
import { useSubshellLabels } from "@/hooks/use-subshell-labels";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { sortByStatus } from "@/lib/subshell-indicator";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import { sectionsByNode, sectionsByStatus } from "@/lib/subshell-sections";
import { subshellTree } from "@/lib/subshell-tree";
import { requestWorkspacePaneFocus, useWorkspaceFocusedId } from "@/lib/workspace-focus";

const GROUP_KEY = "subshell.sidebarGroupBy";
const GROUP_OPTIONS = [
  { value: "machine", label: "By machine" },
  { value: "status", label: "By status" },
  { value: "none", label: "No grouping" },
] as const;
type GroupBy = (typeof GROUP_OPTIONS)[number]["value"];

function savedGroupBy(): GroupBy {
  try {
    const value = localStorage.getItem(GROUP_KEY);
    if (value === "status" || value === "none") return value;
  } catch {
    // The sidebar still works when browser storage is unavailable.
  }
  return "machine";
}

/** Every visible subshell, using the same live cache and actions as workspace rows. */
export function AllSubshellsSection({
  workspaceId,
  onAction,
  excludeIds,
}: {
  workspaceId?: string;
  excludeIds?: ReadonlySet<string>;
  onAction?: () => void;
}) {
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  const focusedId = useWorkspaceFocusedId();
  const { data: workspaces } = useWorkspaces();
  const memberIds = new Set(
    workspaces?.find((workspace) => workspace.id === workspaceId)?.panes?.map((pane) => pane.subshellId),
  );
  const results = useSubshellsList();
  const labelsFor = useSubshellLabels();
  const { data: nodes } = useNodes();
  const [groupBy, setGroupBy] = useState<GroupBy>(savedGroupBy);
  const sorted = sortByStatus((results.data ?? []).filter((row) => row.crossAgent || !excludeIds?.has(row.id)));
  const { roots, children } = subshellTree(sorted);
  const sections =
    groupBy === "machine"
      ? sectionsByNode(
          groupSubshellsByNode(roots, nodes?.nodes, { unanswered: nodes === undefined, groupShared: true }),
        )
      : groupBy === "status"
        ? sectionsByStatus(roots)
        : [{ key: "all", label: "", title: "", subshells: roots }];
  const addSubshell = () => {
    if (workspaceId) {
      void navigate({ to: "/workspaces/$id", params: { id: workspaceId }, search: { picker: true } });
    } else {
      quickAdd.openLaunch();
    }
    onAction?.();
  };
  return (
    <section aria-label="Subshells" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <Select
          value={groupBy}
          items={GROUP_OPTIONS}
          onValueChange={(value) => {
            if (value !== "machine" && value !== "status" && value !== "none") return;
            setGroupBy(value);
            try {
              localStorage.setItem(GROUP_KEY, value);
            } catch {
              // Keep the current choice even when it cannot be saved.
            }
          }}
        >
          <SelectTrigger aria-label="Group sidebar subshells by" className="h-7 min-w-0 flex-1 px-2 py-0.5 text-detail">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {GROUP_OPTIONS.map(({ value, label }) => (
                <SelectItem size="compact" key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <ActionsMenu
          label="Subshells"
          items={[
            {
              label: "Add subshell",
              icon: Plus,
              onSelect: addSubshell,
            },
            {
              label: "Subshell dashboard",
              icon: ChartNoAxesCombined,
              onSelect: () => {
                void navigate({ to: "/subshells" });
                onAction?.();
              },
            },
          ]}
        />
      </div>

      {results.isError ? (
        <ListLoadError message="Couldn’t load subshells." retry={results.refetch} busy={results.isFetching} />
      ) : results.isLoading ? (
        <p className="px-3 text-detail text-muted-foreground">Loading subshells…</p>
      ) : roots.length ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-2">
          {sections.map((section) => (
            <div key={section.key}>
              {section.label && <SidebarGroupHeading>{section.label}</SidebarGroupHeading>}
              {section.subshells.map((subshell) => (
                <SubshellTreeRow
                  key={subshell.id}
                  subshell={subshell}
                  focusedId={workspaceId ? focusedId : null}
                  childrenByParent={children}
                  memberIds={memberIds}
                  showMembership
                  workspaceId={workspaceId}
                  labelsFor={labelsFor}
                  onOpen={
                    workspaceId
                      ? (selected) => {
                          if (requestWorkspacePaneFocus(selected.id, workspaceId)) return;
                          void navigate({
                            to: "/workspaces/$id",
                            params: { id: workspaceId },
                            search: { add: selected.id, dir: "within" },
                          });
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        // One quiet line, the Workspaces section's idiom: the section's header
        // already owns the Add-subshell act, so a filled CTA here only competes
        // with it (operator ruling 2026-10-20).
        <p className="px-1 py-2 text-detail text-muted-foreground">
          {excludeIds?.size
            ? "Drag a subshell here to remove it from the workspace."
            : "No subshells yet. Start an agent or a terminal session to get going."}
        </p>
      )}
    </section>
  );
}
