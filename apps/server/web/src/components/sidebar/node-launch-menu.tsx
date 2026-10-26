import { apiFetch, type Node } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { Plus, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useQuickAdd } from "@/components/quick-add";
import { TippedIconButton } from "@/components/tipped-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCreateSubshell } from "@/hooks/use-create-subshell";
import { usePublicSettings } from "@/hooks/use-public-settings";
import type { RecentPathsResponse } from "@/hooks/use-recent-paths";
import { createSubshellErrorMessage } from "@/lib/create-subshell-error";
import { currentWorkspaceId } from "@/lib/current-workspace";
import { isOfflineAgent } from "@/lib/node-label";

/** Launch on the machine named by a sidebar group, without another machine picker. */
export function NodeLaunchMenu({ node, onAction }: { node?: Node; onAction?: () => void }) {
  return node ? <ResolvedNodeLaunchMenu node={node} onAction={onAction} /> : null;
}

function ResolvedNodeLaunchMenu({ node, onAction }: { node: Node; onAction?: () => void }) {
  const quickAdd = useQuickAdd();
  const navigate = useNavigate();
  const create = useCreateSubshell();
  const { data: settings } = usePublicSettings();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const reason = busy
    ? "Wait for the terminal to start."
    : settings?.lockdown
      ? "Subshells can't start while lockdown is on."
      : node.maintenance
        ? "This machine is in maintenance mode."
        : isOfflineAgent(node)
          ? "This machine is offline."
          : !node.canLaunch
            ? "You can't start subshells on this machine."
            : undefined;

  async function startTerminal() {
    if (reason || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const recent = await apiFetch<RecentPathsResponse>(`/api/files/recent?node=${encodeURIComponent(node.id)}`);
      const workingDir = recent.paths[0]?.path ?? recent.home;
      if (!workingDir)
        throw new Error("This machine hasn't reported a working directory. Open New subshell to choose one.");
      const created = await create.mutateAsync({ harnessId: "terminal", nodeId: node.id, workingDir });
      onAction?.();
      const landing = created.workspaceId ?? currentWorkspaceId();
      if (landing) void navigate({ to: "/workspaces/$id", params: { id: landing } });
      else void navigate({ to: "/subshells/$id", params: { id: created.id } });
    } catch (error) {
      toast.error(createSubshellErrorMessage(error, "Couldn't start the terminal."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TippedIconButton
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground [&_svg]:size-3"
            tooltip={`New subshell on ${node.name}`}
            disabled={Boolean(reason)}
            disabledReason={reason}
          />
        }
      >
        <Plus />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => void startTerminal()}>
            <SquareTerminal className="size-4" />
            New terminal
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (reason) return;
              quickAdd.openLaunch(node.id);
              onAction?.();
            }}
          >
            <Plus className="size-4" />
            New subshell
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
