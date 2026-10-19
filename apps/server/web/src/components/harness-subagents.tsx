import { Button, cn } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, Undo2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHarnessSubagents, useSelectHarnessAgent } from "@/hooks/use-harness-subagents";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus } from "@/lib/workspace-focus";

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
  return (
    <div className="relative -mt-1 ml-[15px] flex min-w-0 flex-col pt-1 before:absolute before:top-0 before:left-0 before:h-1 before:border-border before:border-l">
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
                    aria-disabled={!data.canSelect || select.isPending}
                    onClick={() => {
                      if (!data.canSelect || select.isPending) return;
                      select.mutate(agent.id, {
                        onSuccess: () => {
                          if (requestWorkspacePaneFocus(id, branchWorkspaceId)) return;
                          if (branchWorkspaceId) {
                            armPaneFocusOnArrive(id);
                            void navigate({ to: "/workspaces/$id", params: { id: branchWorkspaceId } });
                          } else void navigate({ to: "/subshells/$id", params: { id } });
                        },
                      });
                    }}
                  />
                }
              >
                <span
                  role="img"
                  aria-label={agent.status}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agent.status === "waiting"
                      ? "bg-warning"
                      : agent.status === "idle"
                        ? "bg-muted-foreground"
                        : "bg-success",
                  )}
                />
                <span className="truncate">{agent.name}</span>
              </TooltipTrigger>
              <TooltipContent>
                {select.isPending
                  ? "Switching agent views…"
                  : !data.canSelect
                    ? data.unavailableReason
                    : "Show in the parent terminal. Everyone attached sees this view."}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
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

/** Only confirmed native selection changes the header; never rename the parent. */
export function HarnessSubagentTitle({ id, parentName }: { id: string; parentName: string }) {
  const { data } = useHarnessSubagents(id);
  const select = useSelectHarnessAgent(id);
  if (!data?.selectedId) return null;
  const agent = data.agents.find((row) => row.id === data.selectedId);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" aria-label={`Subagent of ${parentName}`} className="shrink-0" />}
          >
            <GitBranch className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Subagent of {parentName}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {agent && (
        <span
          role="img"
          aria-label={agent.status}
          className={cn(
            "size-2 shrink-0 rounded-full",
            agent.status === "waiting" ? "bg-warning" : agent.status === "idle" ? "bg-muted-foreground" : "bg-success",
          )}
        />
      )}
      <span className="truncate">{agent?.name ?? "Subagent"}</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back to main agent"
                aria-disabled={!data.canSelect || select.isPending}
                onClick={() => {
                  if (data.canSelect && !select.isPending) select.mutate(null);
                }}
              />
            }
          >
            <Undo2 />
          </TooltipTrigger>
          <TooltipContent>
            {select.isPending
              ? "Switching agent views…"
              : !data.canSelect
                ? data.unavailableReason
                : "Back to main agent"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {select.isError && (
        <span role="alert" className="text-destructive text-detail">
          Couldn't switch views.
        </span>
      )}
    </span>
  );
}
