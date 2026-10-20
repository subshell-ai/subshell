import { apiFetch, cn } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { useMemo } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { HarnessSubagentTitle } from "@/components/harness-subagents";
import { SshPaneLabels } from "@/components/ssh-pane-labels";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { TrustIndicators } from "@/components/trust-indicators";
import { useHarnessSubagents } from "@/hooks/use-harness-subagents";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useIsStackedHeader } from "@/hooks/use-is-stacked-header";
import { useNodes } from "@/hooks/use-nodes";
import { usePaneCopyMode } from "@/hooks/use-pane-copy-mode";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { useTrustNotices } from "@/hooks/use-trust-notices";
import { invalidateAfterRename } from "@/hooks/use-workspaces";
import { FALLBACK_NODE_ID, nodeLabelFor } from "@/lib/subshell-node-groups";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";
import type { WorkspacePaneRow } from "@/types/workspace";

/** Reuse the ordinary subshell actions and keep dialogs bound to this pane. */
function FocusedPaneActions({ id }: { id: string }) {
  const subshell = useSubshellRow(id);
  const copyMode = usePaneCopyMode(id);
  const coarse = useIsCoarsePointer();
  return subshell ? <SubshellActionsMenu subshell={subshell} copyMode={coarse ? copyMode : undefined} /> : null;
}

/**
 * The bar above a workspace IS the focused pane's subshell header (operator
 * ruling, spec 2026-10-17). The workspace-level header bar is gone: the page
 * shows a set of terminals, and the identity worth a whole header is the pane
 * you are looking at — the same dot, name, directory, disclosures and menu
 * the subshell page gives it. The workspace keeps only its name (renamed from
 * the rail's context menu, opened from the same tree row) and the add-a-pane
 * control the presentation hands in.
 *
 * Focus arrives through `lib/workspace-focus` — the dock publishes the panel
 * it holds active, the tab strip the selected tab — and is constrained to
 * THIS workspace's panes, so a stale focus from another workspace cannot
 * hoist its actions here. Changing the focused pane remounts the menu and the
 * edit control (`key`), so dialogs never outlive the pane they named.
 *
 * An empty workspace has no pane to wear the bar: the name shows in plain,
 * with no control, until the first tab lands.
 */
export function PaneFocusHeader({
  fallbackName,
  panes,
  actions,
}: {
  /** Shown only while no pane exists to be the header. */
  fallbackName: string;
  /** The workspace's panes; focus must name one of these to render as a pane header. */
  panes: WorkspacePaneRow[];
  /** The presentation's add-a-pane control, right-aligned. */
  actions?: ReactNode;
}): JSX.Element {
  const focusedId = useWorkspaceFocusedId();
  const focusedPane = panes.find((pane) => pane.subshellId === focusedId);
  const subshell = useSubshellRow(focusedPane?.subshellId ?? "");
  const trustNotices = useTrustNotices(focusedPane ? subshell : undefined);
  const stacked = useIsStackedHeader();
  const { data: nodesData } = useNodes();
  const queryClient = useQueryClient();
  const nodeLabel = useMemo(
    () => nodeLabelFor(subshell?.nodeId || FALLBACK_NODE_ID, nodesData?.nodes, nodesData === undefined).label,
    [subshell?.nodeId, nodesData],
  );

  /** Renames the focused subshell — the same PATCH the subshell page's title edit makes. */
  async function saveName(name: string): Promise<void> {
    if (!focusedPane) return;
    const id = focusedPane.subshellId;
    await apiFetch(`/api/subshells/${id}/name`, { method: "PATCH", body: JSON.stringify({ name }) });
    invalidateAfterRename(queryClient, id);
  }

  // A dead pane is a mounted header, so liveness gates the poll here too,
  // same as the rail and the agent page.
  const { data: agentState } = useHarnessSubagents(
    subshell && subshell.status === "running" && subshell.alive === true ? subshell.id : "",
  );
  const isPane = Boolean(focusedPane && subshell);
  const showingAgent = isPane && subshell && agentState?.selectedId;
  return (
    <DetailBackHeader
      to="/workspaces"
      backLabel="Back to workspaces"
      hideBack
      title={
        showingAgent && subshell ? (
          <HarnessSubagentTitle
            id={subshell.id}
            parentName={subshell.name}
            alive={subshell.status === "running" && subshell.alive === true}
          />
        ) : isPane && subshell ? (
          /* The state rides beside the name, as it does on the subshell page:
             the dot is the only carrier of the state here, so `accessible`. */
          <span className="flex min-w-0 items-center gap-2">
            <SubshellDot subshell={subshell} accessible className="mt-0 h-2 w-2" />
            {stacked ? (
              <span className="truncate">{subshell?.name}</span>
            ) : (
              <EditableText
                key={focusedPane?.subshellId}
                value={subshell?.name ?? ""}
                label="Rename subshell"
                onSave={saveName}
                className="font-strong"
                inputClassName="w-56"
              />
            )}
          </span>
        ) : (
          <span className={cn("truncate", stacked && "font-normal")}>{fallbackName}</span>
        )
      }
      /* Same indent rule the subshell page applies: the path lines up with
         whichever title is on screen. The subagent title's `size-4` icon
         (16px) plus `gap-2` is `pl-6`; the dot's box (`w-2` 8px) plus
         `gap-2` is `pl-4`. */
      subtitle={
        subshell?.workingDir ? (
          <span className={cn("block truncate", showingAgent ? "pl-6" : "pl-4")}>{subshell.workingDir}</span>
        ) : undefined
      }
      actions={
        <>
          {isPane && subshell && <SshPaneLabels subshell={subshell} nodeLabel={nodeLabel} />}
          {isPane && <TrustIndicators notices={trustNotices} />}
          {focusedPane && <FocusedPaneActions key={focusedPane.subshellId} id={focusedPane.subshellId} />}
          {actions}
        </>
      }
    />
  );
}
