import { Button, cn } from "@internal/node-admin";
import type { HarnessSubagent, HarnessSubagentSnapshot, HarnessSubagentView } from "@subshell-ai/plugin-api";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, Undo2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHarnessSubagents, useSelectHarnessAgent } from "@/hooks/use-harness-subagents";
import { formatDuration } from "@/lib/format-units";
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
 * Whether the switch control is currently inert and how to say why. Both
 * surfaces ask the same question of the same snapshot, so the answer is one
 * function, not two ternaries that drift apart.
 */
function selectionState(data: HarnessSubagentSnapshot, pending: boolean) {
  const blocked = !data.canSelect || pending;
  const reason = pending
    ? "Switching agent views…"
    : data.canSelect
      ? undefined
      : // A reason that renders as nothing is no reason: fall through to the
        // default sentence rather than tooltip an empty explanation. It is
        // the server's own default wording, so one situation stays one
        // sentence wherever either is rendered.
        data.unavailableReason ||
        "Subshell can't switch views in this harness yet. Use the harness's own agent selector.";
  return { blocked, reason };
}

/**
 * "running · 4m 35s": the harness's status word beside the time since the
 * server first saw this child. Deliberately not "running FOR 4m 35s": the
 * stamp is first-sighting, and a child can change status without a new
 * event, so no duration belongs to the status word itself.
 */
function spentLine(agent: HarnessSubagentView): string {
  const seconds = Math.floor((Date.now() - agent.startedAt) / 1000);
  return seconds < 1 ? agent.status : `${agent.status} · ${formatDuration(seconds)}`;
}

/**
 * A child's visible name and activity share a compact two-line row.
 */
function AgentRowText({ agent, showActivity }: { agent: HarnessSubagent; showActivity: boolean }) {
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 text-left">
      <AgentStatusDot agent={agent} className="size-1.5" />
      <span className="truncate">{agent.name}</span>
      {showActivity && agent.activity && (
        <span
          className="col-start-2 truncate text-muted-foreground"
          style={{ fontSize: "calc(var(--text-detail) - 1px)" }}
        >
          {agent.activity}
        </span>
      )}
    </span>
  );
}

function AgentTooltipLines({ agent, lead, hint }: { agent: HarnessSubagentView; lead?: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {lead && <p style={{ fontSize: "calc(var(--text-detail) - 1px)" }}>{lead}</p>}
      <p className="text-muted-foreground">{spentLine(agent)}</p>
      {hint && <p className="text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The card as one sentence, for the `aria-description` of a disabled control. */
function agentTooltipText(agent: HarnessSubagentView, lead?: string): string {
  // A sentence-joined string must not carry a doubled period or lack its
  // final one: trim each line's terminator, then join and close.
  const lines = [lead, spentLine(agent)]
    .filter((line): line is string => Boolean(line))
    .map((line) => line.replace(/[.…]+$/, ""));
  return lines.length ? `${lines.join(". ")}.` : "";
}

/** The shared failure line under both switch surfaces. */
function SwitchAgentError() {
  return (
    <span role="alert" className="text-destructive text-detail">
      Couldn't switch agent views. Try again.
    </span>
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
  harnessId,
}: {
  id: string;
  alive: boolean;
  branchWorkspaceId?: string;
  harnessId?: string;
}) {
  const navigate = useNavigate();
  const { data } = useHarnessSubagents(id, alive);
  const select = useSelectHarnessAgent(id);
  if (!data?.agents.length) return null;
  const { blocked, reason } = selectionState(data, select.isPending);
  // Claude's tool descriptions aren't its live task-picker summaries. Showing
  // them here makes the sidebar look stale even when reports arrive correctly.
  const showActivity = harnessId !== "claude-code";
  return (
    <div className="relative -mt-1 ml-4 flex min-w-0 flex-col pt-1 before:absolute before:top-0 before:left-0 before:h-1 before:border-border before:border-l">
      {data.agents.map((agent, index) => (
        <div key={agent.id} className="relative min-w-0 pl-3">
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 left-0 border-border border-l",
              index === data.agents.length - 1 ? "h-3.5" : "h-full",
            )}
          />
          <span aria-hidden="true" className="pointer-events-none absolute top-3.5 left-0 w-3 border-border border-t" />
          {blocked ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-auto min-h-7 w-full justify-start gap-1.5 px-2 py-1 font-regular text-detail [&_svg]:size-3",
                data.selectedId === agent.id && "bg-accent",
              )}
              disabled
              disabledReason={<AgentTooltipLines agent={agent} lead={reason} />}
              disabledReasonText={agentTooltipText(agent, reason)}
            >
              <AgentRowText agent={agent} showActivity={showActivity} />
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
                        "h-auto min-h-7 w-full justify-start gap-1.5 px-2 py-1 font-regular text-detail [&_svg]:size-3",
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
                  <AgentRowText agent={agent} showActivity={showActivity} />
                </TooltipTrigger>
                <TooltipContent>
                  <AgentTooltipLines
                    agent={agent}
                    hint="Show in the parent terminal. Everyone attached sees this view."
                  />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ))}
      {select.isError && <SwitchAgentError />}
    </div>
  );
}

/**
 * The header title while a reported child is on screen: the parent's name is
 * never renamed, this only marks which agent the pane is showing and offers
 * the return. Renders nothing until the server confirms a selection. Pass
 * `alive` with the parent's liveness: a dead row keeps no child to show, and
 * the poll must not restart just because a cached snapshot still names one.
 */
export function HarnessSubagentTitle({ id, parentName, alive }: { id: string; parentName: string; alive: boolean }) {
  const { data } = useHarnessSubagents(id, alive);
  const select = useSelectHarnessAgent(id);
  if (!data?.selectedId) return null;
  const agent = data.agents.find((row) => row.id === data.selectedId);
  const { blocked, reason } = selectionState(data, select.isPending);
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
      {select.isError && <SwitchAgentError />}
    </span>
  );
}
