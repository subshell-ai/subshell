import { cn, errMessage } from "@internal/node-admin";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSubshellDrop } from "@/hooks/use-subshell-drop";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { acceptsSubshellDrag } from "@/lib/subshell-dnd";
import { requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { WorkspaceRow } from "@/types/workspace";

interface SidebarDrag {
  id: string | null;
  start: (id: string) => void;
  end: () => void;
  workspace?: WorkspaceRow;
  busy: boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
}
const Context = createContext<SidebarDrag | null>(null);
export const useWorkspaceSidebarDrag = () => useContext(Context);

/** One transfer controller for both sidebar sections; no process lifecycle calls. */
export function WorkspaceSidebarDrag({ workspace, children }: { workspace?: WorkspaceRow; children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const adding = Boolean((location.search as { add?: string }).add);
  const invalidate = useInvalidateWorkspaces();
  const { addPane, removePane } = useWorkspacePaneMutations(workspace?.id ?? "");
  useEffect(() => {
    const end = () => setId(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);
  // Switching workspace during a drag must not transfer into a different one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the gesture when its destination changes
  useEffect(() => setId(null), [workspace?.id]);

  const currentPath = useRef(location.pathname);
  currentPath.current = location.pathname;
  const destination = useRef(workspace?.id);
  destination.current = workspace?.id;

  const add = async (subshellId: string) => {
    if (!workspace || pending.current || adding) return;
    if (requestWorkspacePaneFocus(subshellId, workspace.id)) return;
    const targetId = workspace.id;
    pending.current = true;
    setBusy(true);
    try {
      // Persist against the drop target before any navigation. A URL intent
      // can outlive the workspace it was meant to change.
      await addPane(subshellId);
      await invalidate();
      if (destination.current === targetId) requestWorkspacePaneFocus(subshellId, targetId);
    } catch (error) {
      toast.error(errMessage(error, "Couldn't add the subshell to this workspace."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const remove = async (subshellId: string) => {
    const pane = workspace?.panes?.find((row) => row.subshellId === subshellId);
    if (!pane || !workspace || pending.current || adding) return;
    pending.current = true;
    setBusy(true);
    try {
      const { workspaceDeleted } = await removePane(pane.id);
      await invalidate();
      // Dragging the last tab out retires the workspace (operator ruling
      // 2026-10-20; the subshell keeps running, unfiled). If the retired row
      // is the page on screen, the workspace route has nothing to show —
      // land on the Subshells list, which is where this gesture pointed.
      if (workspaceDeleted && currentPath.current === `/workspaces/${workspace.id}`) {
        void navigate({ to: "/subshells", replace: true });
      }
    } catch (error) {
      toast.error(errMessage(error, "Couldn't remove the subshell from this workspace."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Context.Provider
      value={{ id, start: setId, end: () => setId(null), workspace, busy: busy || adding, add, remove }}
    >
      {children}
    </Context.Provider>
  );
}

/** The overlay never changes layout or becomes part of a dragged row's image. */
export function WorkspaceSidebarDropArea({
  kind,
  children,
  className,
}: {
  kind: "add" | "remove";
  children: ReactNode;
  className?: string;
}) {
  const drag = useWorkspaceSidebarDrag();
  const readSubshellDrop = useSubshellDrop();
  const [over, setOver] = useState(false);
  const member = drag?.workspace?.panes?.some((pane) => pane.subshellId === drag.id) ?? false;
  const offered = !!drag?.workspace && !!drag.id && (kind === "remove" ? member : !member);
  const blocked = drag?.busy;
  useEffect(() => {
    if (!drag?.id) setOver(false);
  }, [drag?.id]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: MIME-scoped drop area; row menus and links provide keyboard/touch equivalents
    <div
      data-sidebar-drop={kind}
      className={cn("relative min-h-16", className)}
      onDragOver={(event) => {
        if (!acceptsSubshellDrag(event.dataTransfer) || !offered) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = blocked ? "none" : "move";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setOver(false);
        }
      }}
      onDrop={(event) => {
        if (!acceptsSubshellDrag(event.dataTransfer) || !offered || !drag) return;
        event.preventDefault();
        event.stopPropagation();
        const id = readSubshellDrop(event.dataTransfer);
        if (id && id === drag.id && !blocked) (kind === "add" ? drag.add : drag.remove)(id);
        drag.end();
        setOver(false);
      }}
    >
      {children}
      {offered && (
        <div
          className={cn(
            "pointer-events-none absolute inset-1 flex items-center justify-center rounded-md border border-primary border-dashed bg-card/90 p-3 text-center text-detail",
            over && "border-solid bg-accent/95",
            blocked && "border-warning text-warning",
          )}
        >
          <span role="status">
            {drag?.busy ? "Updating workspace…" : kind === "add" ? "Add to workspace" : "Remove from workspace"}
          </span>
        </div>
      )}
    </div>
  );
}
