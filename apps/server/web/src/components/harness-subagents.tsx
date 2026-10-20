import { Button, cn } from "@internal/node-admin";
import type { HarnessSubagent } from "@subshell-ai/plugin-api";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, Undo2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHarnessSubagents, useSelectHarnessAgent } from "@/hooks/use-harness-subagents";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus } from "@/lib/workspace-focus";

/**
 * The status dot every subagent row wears. `role="img"` keeps it out of the
 * tab order; the name beside it carries the identity.
 */
function AgentStatusDot({ agent, className }: { agent: HarnessSubagent; className: string }) {
  return (
    <span
      role="img"
      aria-label={agent.status}
      className={cn(
        "shrink-0 rounded-full",
        className,
        agent.status === "waiting" ? "bg-warning" : agent.status === "idle" ? "bg-muted-foreground" : "bg-success",
      )}
    />
  );
}

/**
 * The collapsible child rows under a live parent in the rail. Clicking a child
 * moves the PARENT's own terminal onto that agent (no new pane); the server
 * decides whether this viewer may do that (`canSelect`) and why not
 * (`unavailableReason`), and the row only ever renders what that answer allows.
 * A queued command is not a confirmed view change, so the selection highlight
 * follows the next poll rather than the click.
 */
export function HarnessSubagentRows({
  id,
  alive,
  branchWorkspaceId,
}: {
  id: string;
  alive: boolean;
  branchWorkspaceId?: string;
}) {
  const navigate = useNavigate();
  const { data } = useHarnessSubagents(id, alive);
  const select = useSelectHarnessAgent(id);
  if (!data?.agents.length) return null;
  const blocked = !data.canSelect || select.isPending;
  const reason = select.isPending
    ? "Switching agent views…"
    : data.canSelect
      ? undefined
      : (data.unavailableReason ?? "This agent does not support switching views.");
  return (
    <div className="relative -mt-1 ml-4 flex min-w-0 flex-col pt-1 before:absolute before:top-0 before:left-0 before:h-1 before:border-border before:border-l">
      {data.agents.map((agent, index) => (
        <div key={agent.id} className="relative min-w-0 pl-3">
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 left-0 border-border border-l",
              index === data.agents.length - 1 ? "h-1/2" : "h-full",
            )}
          />
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-0 w-3 border-border border-t" />
          {blocked ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 w-full justify-start gap-1.5 px-2 font-regular text-detail [&_svg]:size-3",
                data.selectedId === agent.id && "bg-accent",
              )}
              disabled
              disabledReason={reason}
            >
              <AgentStatusDot agent={agent} className="size-1.5" />
              <span className="truncate">{agent.name}</span>
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-7 w-full justify-start gap-1.5 px-2 font-regular text-detail [&_svg]:size-3",
                        data.selectedId === agent.id && "bg-accent",
                      )}
                      onClick={() =>
                        select.mutate(agent.id, {
                          onSuccess: () => {
                            if (requestWorkspacePaneFocus(id, branchWorkspaceId)) return;
                            if (branchWorkspaceId) {
                              armPaneFocusOnArrive(id);
                              void navigate({ to: "/workspaces/$id", params: { id: branchWorkspaceId } });
                            } else void navigate({ to: "/subshells/$id", params: { id } });
                          },
                        })
                      }
                    />
                  }
                >
                  <AgentStatusDot agent={agent} className="size-1.5" />
                  <span className="truncate">{agent.name}</span>
                </TooltipTrigger>
                <TooltipContent>Show in the parent terminal. Everyone attached sees this view.</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ))}
      {select.isError && (
        <p role="alert" className="text-destructive text-detail">
          Couldn't switch agent views. Try again.
        </p>
      )}
    </div>
  );
}

/**
 * The header title while a reported child is on screen: the parent's name is
 * never renamed, this only marks which agent the pane is showing and offers
 * the return. Renders nothing until the server confirms a selection.
 */
export function HarnessSubagentTitle({ id, parentName }: { id: string; parentName: string }) {
  const { data } = useHarnessSubagents(id);
  const select = useSelectHarnessAgent(id);
  if (!data?.selectedId) return null;
  const agent = data.agents.find((row) => row.id === data.selectedId);
  const blocked = !data.canSelect || select.isPending;
  const reason = select.isPending
    ? "Switching agent views…"
    : data.canSelect
      ? undefined
      : (data.unavailableReason ?? "This agent does not support switching views.");
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span role="img" aria-label={`Subagent of ${parentName}`} className="flex shrink-0">
        <GitBranch className="size-4" aria-hidden="true" />
      </span>
      {agent && <AgentStatusDot agent={agent} className="size-2" />}
      <span className="truncate">{agent?.name ?? "Subagent"}</span>
      {blocked ? (
        <Button variant="ghost" size="icon" aria-label="Back to main agent" disabled disabledReason={reason}>
          <Undo2 />
        </Button>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to main agent"
                  onClick={() => select.mutate(null)}
                />
              }
            >
              <Undo2 />
            </TooltipTrigger>
            <TooltipContent>Back to main agent</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {select.isError && (
        <span role="alert" className="text-destructive text-detail">
          Couldn't switch agent views. Try again.
        </span>
      )}
    </span>
  );
}
