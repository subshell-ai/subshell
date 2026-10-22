import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import type { SubshellView } from "@/types/subshell";

/** A real subshell row with its agent-created helpers nested below it. */
export function SubshellTreeRow({
  subshell,
  childrenByParent,
  focusedId,
  labelsFor,
  workspaceId,
  memberIds,
  onOpen,
  parentNodeId,
  showMembership = false,
}: {
  subshell: SubshellView;
  childrenByParent: ReadonlyMap<string, SubshellView[]>;
  focusedId: string | null;
  labelsFor: (subshell: SubshellView) => { nodeLabel: string; agentLabel: string; presetLabel?: string };
  workspaceId?: string;
  memberIds?: ReadonlySet<string>;
  onOpen?: (subshell: SubshellView) => void;
  parentNodeId?: string;
  showMembership?: boolean;
}) {
  const children = childrenByParent.get(subshell.id) ?? [];
  const labels = labelsFor(subshell);
  function containsFocus(id: string): boolean {
    return id === focusedId || (childrenByParent.get(id) ?? []).some((child) => containsFocus(child.id));
  }
  return (
    <div
      data-subshell-tree-id={subshell.id}
      className={
        parentNodeId
          ? "relative before:pointer-events-none before:absolute before:top-4 before:-left-2 before:w-2 before:border-border before:border-t"
          : undefined
      }
    >
      <SubshellRecentRow
        subshell={subshell}
        focused={focusedId === subshell.id}
        expandChildren={containsFocus(subshell.id)}
        inActiveWorkspace={showMembership && memberIds?.has(subshell.id)}
        {...labels}
        branchWorkspaceId={memberIds?.has(subshell.id) ? workspaceId : undefined}
        subline={
          parentNodeId && parentNodeId !== subshell.nodeId ? `${labels.nodeLabel} · ${subshell.workingDir}` : undefined
        }
        onOpen={onOpen ? () => onOpen(subshell) : undefined}
      >
        {children.length > 0 && (
          <section className="ml-5 border-l pl-2" aria-label={`Subshells created by ${subshell.name}`}>
            {children.map((child) => (
              <SubshellTreeRow
                key={child.id}
                subshell={child}
                childrenByParent={childrenByParent}
                focusedId={focusedId}
                labelsFor={labelsFor}
                workspaceId={workspaceId}
                memberIds={memberIds}
                onOpen={onOpen}
                parentNodeId={subshell.nodeId ?? "local"}
                showMembership={showMembership}
              />
            ))}
          </section>
        )}
      </SubshellRecentRow>
    </div>
  );
}
