import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesCombined, Plus } from "lucide-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { ListLoadError } from "@/components/list-load-error";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { SubshellSearch } from "@/components/subshell-search";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/hooks/use-nodes";
import { useSubshellLabels } from "@/hooks/use-subshell-labels";
import { useFilteredSubshells } from "@/hooks/use-subshells";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { sortByStatus } from "@/lib/subshell-indicator";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import { sectionsByNode, sectionsByStatus } from "@/lib/subshell-sections";
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
  query,
  onQueryChange,
  workspaceId,
  onAction,
}: {
  workspaceId?: string;
  onAction?: () => void;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  const focusedId = useWorkspaceFocusedId();
  const { data: workspaces } = useWorkspaces();
  const memberIds = new Set(
    workspaces?.find((workspace) => workspace.id === workspaceId)?.panes?.map((pane) => pane.subshellId),
  );
  const results = useFilteredSubshells(query);
  const labelsFor = useSubshellLabels();
  const { data: nodes } = useNodes();
  const [groupBy, setGroupBy] = useState<GroupBy>(savedGroupBy);
  const sorted = sortByStatus(results.data ?? []);
  const sections =
    groupBy === "machine"
      ? sectionsByNode(
          groupSubshellsByNode(sorted, nodes?.nodes, { unanswered: nodes === undefined, groupShared: true }),
        )
      : groupBy === "status"
        ? sectionsByStatus(sorted)
        : [{ key: "all", label: "", title: "", subshells: sorted }];
  return (
    <section aria-label="Subshells" className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <SubshellSearch
          ariaLabel="Filter sidebar subshells"
          value={query}
          onChange={onQueryChange}
          className="min-w-0 flex-1"
        />
        <ActionsMenu
          label="Subshells"
          items={[
            {
              label: "Add subshell",
              icon: Plus,
              onSelect: () => {
                if (workspaceId) {
                  void navigate({ to: "/workspaces/$id", params: { id: workspaceId }, search: { picker: true } });
                } else {
                  quickAdd.openLaunch();
                }
                onAction?.();
              },
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
        <SelectTrigger aria-label="Group sidebar subshells by">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {GROUP_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {results.isError ? (
        <ListLoadError message="Couldn’t load subshells." retry={results.refetch} busy={results.isFetching} />
      ) : results.isLoading ? (
        <p className="px-3 text-detail text-muted-foreground">Loading subshells…</p>
      ) : results.data?.length ? (
        <div className="flex flex-col gap-3">
          {sections.map((section) => (
            <div key={section.key}>
              {section.label && (
                <h3 className="px-3 py-1 font-strong text-detail text-muted-foreground">{section.label}</h3>
              )}
              {section.subshells.map((subshell) => (
                <SubshellRecentRow
                  key={subshell.id}
                  subshell={subshell}
                  focused={Boolean(workspaceId && focusedId === subshell.id)}
                  inActiveWorkspace={memberIds.has(subshell.id)}
                  {...labelsFor(subshell)}
                  onOpen={
                    workspaceId
                      ? () => {
                          if (requestWorkspacePaneFocus(subshell.id, workspaceId)) return;
                          void navigate({
                            to: "/workspaces/$id",
                            params: { id: workspaceId },
                            search: { add: subshell.id, dir: "within" },
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
        <p className="px-3 text-detail text-muted-foreground">
          {query.trim() ? "No subshells match your search." : "No subshells yet."}
        </p>
      )}
    </section>
  );
}
