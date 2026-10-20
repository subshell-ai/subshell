import { cn, errMessage } from "@internal/node-admin";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, type DragEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { readSubshellDrag, SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
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
  const { removePane } = useWorkspacePaneMutations(workspace?.id ?? "");
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

  const add = (subshellId: string) => {
    if (!workspace || pending.current || adding) return;
    if (requestWorkspacePaneFocus(subshellId, workspace.id)) return;
    // The route's existing add-intent path creates and focuses the dock tab.
    pending.current = true;
    setBusy(true);
    void navigate({ to: "/workspaces/$id", params: { id: workspace.id }, search: { add: subshellId, dir: "within" } })
      .catch((error) => toast.error(errMessage(error, "Couldn't open the workspace.")))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const remove = async (subshellId: string) => {
    const pane = workspace?.panes?.find((row) => row.subshellId === subshellId);
    if (!pane || !workspace || pending.current || adding) return;
    if (workspace.subshellCount <= 1) {
      toast.error("Add another subshell before removing the last tab.");
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await removePane(pane.id);
      await invalidate();
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
  const [over, setOver] = useState(false);
  const member = drag?.workspace?.panes?.some((pane) => pane.subshellId === drag.id) ?? false;
  const offered = !!drag?.workspace && !!drag.id && (kind === "remove" ? member : !member);
  const blocked = drag?.busy || (kind === "remove" && (drag?.workspace?.subshellCount ?? 0) <= 1);
  const accepts = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(SUBSHELL_DND_TYPE);
  useEffect(() => {
    if (!drag?.id) setOver(false);
  }, [drag?.id]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: MIME-scoped drop area; row menus and links provide keyboard/touch equivalents
    <div
      data-sidebar-drop={kind}
      className={cn("relative min-h-16", className)}
      onDragOver={(event) => {
        if (!accepts(event) || !offered) return;
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
        if (!accepts(event) || !offered || !drag) return;
        event.preventDefault();
        event.stopPropagation();
        const id = readSubshellDrag(event.dataTransfer);
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
            {drag?.busy
              ? "Updating workspace…"
              : blocked
                ? "Add another subshell before removing the last tab."
                : kind === "add"
                  ? "Add to workspace"
                  : "Remove from workspace"}
          </span>
        </div>
      )}
    </div>
  );
}
