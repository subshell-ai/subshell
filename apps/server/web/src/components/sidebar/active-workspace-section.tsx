import { apiFetch, apiPost, cn } from "@internal/node-admin";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ListLoadError } from "@/components/list-load-error";
import { useQuickAdd } from "@/components/quick-add";
import { AllSubshellsSection } from "@/components/sidebar/all-subshells-section";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { WorkspaceSidebarDrag, WorkspaceSidebarDropArea } from "@/components/sidebar/workspace-sidebar-drag";
import { WorkspaceBranch } from "@/components/sidebar/workspaces-section";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useSubshellLabels } from "@/hooks/use-subshell-labels";
import { useSubshellsList } from "@/hooks/use-subshells";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { lastWorkspaceId } from "@/lib/current-workspace";
import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import { sidebarWorkspace } from "@/lib/sidebar-context";
import { splitCreateFailureMessage, splitWorkspaceRefusal } from "@/lib/split-workspace-refusal";
import { acceptsSubshellDrag, readSubshellDrag } from "@/lib/subshell-dnd";
import { armPaneFocusOnArrive, useWorkspaceFocusedId } from "@/lib/workspace-focus";
import { defaultWorkspaceName } from "@/lib/workspace-name";
import type { WorkspaceRow } from "@/types/workspace";

const NEW_WORKSPACE = "__new_workspace__";

/**
 * The workspace picker and the selected workspace's live, draggable pane rows.
 *
 * With no workspaces at all the section doubles as a drop target (operator ask
 * 2026-10-20): dragging a subshell row from the Subshells section onto the
 * Workspace area CREATES the workspace around that pane and enters it, the
 * same create-with-pane filing the split button and the click-a-row path
 * already use. MIME-scoped like every other drop surface in the rail
 * (`lib/subshell-dnd.ts`), so xterm's file drops and dockview's tab drags stay
 * untouched, and deliberately un-toasted: the workspace appearing and the
 * navigation are the feedback.
 */
export function ActiveWorkspaceSection({ onQuickAdd, headerEnd }: { headerEnd?: ReactNode; onQuickAdd?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  const workspaces = useWorkspaces();
  const subshells = useSubshellsList();
  const focusedId = useWorkspaceFocusedId();
  const invalidate = useInvalidateWorkspaces();
  const rows = workspaces.data ?? [];
  const active = sidebarWorkspace(rows, location.pathname, lastWorkspaceId());
  const memberIds = new Set(active?.panes?.map((pane) => pane.subshellId));
  const standaloneId = subshellIdFromPath(location.pathname);
  const standalone = !active && standaloneId ? subshells.data?.find((row) => row.id === standaloneId) : undefined;
  const labelsFor = useSubshellLabels();

  // The zero-workspace drop zone. Loading and a failed read are not answers of
  // "no workspaces" (the dashboard rule keeps the three distinct), so the zone
  // arms only on a settled, successful, genuinely empty list.
  const noWorkspaces = !workspaces.isLoading && !workspaces.isError && rows.length === 0;
  const [dropHint, setDropHint] = useState(false);
  // True for the WHOLE life of a subshell drag, not just while the pointer is
  // over the zone: a ring that only appears under the cursor answers "where do
  // I drop?" too late (the effect below carries the listener mechanics).
  const [dragArmed, setDragArmed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The in-flight guard rides a ref, not the state: the second drop checks it
  // synchronously, before the re-render `setCreating(true)` schedules lands.
  const createInFlight = useRef(false);
  /** The payload the inline Retry replays after a failed create. */
  const lastDrop = useRef<{ id: string; name: string } | null>(null);

  // A subshell drag dresses the zone for the gesture's WHOLE life, not just
  // while the pointer is over it: pulled from the rail the zone sits off to
  // the side, and a highlight that only appears under the cursor answers
  // "where do I drop?" too late (operator ruling 2026-10-20). The listeners
  // ride the bubble phase on the document, so the row's own onDragStart
  // (the one that encodes the payload) has already run when the event
  // reaches here.
  useEffect(() => {
    if (!noWorkspaces) {
      // The gesture can outlive the zone (the drop that created THIS
      // workspace ends its zero state): disarm, so a later empty list never
      // wears a stale ring. The hover hint leaves with the zone too, beside
      // the failure banner: a later return to the empty state must not
      // resurrect an old error whose Retry now replays into nothing, or an
      // overlay with no drag in flight.
      setDragArmed(false);
      setDropHint(false);
      setCreateError(null);
      lastDrop.current = null;
      return;
    }
    const onDocumentDragStart = (e: globalThis.DragEvent): void => {
      if (e.dataTransfer && acceptsSubshellDrag(e.dataTransfer)) setDragArmed(true);
    };
    // Two listeners, two endings: dragend covers a drag cancelled with ESC
    // or ended away from any target, and drop covers a gesture that landed,
    // because dragend dispatches AT the source row and the document never
    // sees it once that row has unmounted, while drop fires on the attached
    // target and bubbles here. A source that unmounted with no drop at all
    // can still strand the state until the next gesture; the effect re-arms
    // on mount, so the zone is never dressed for a drag that already ended.
    const onDocumentDragEnd = (): void => {
      setDragArmed(false);
      setDropHint(false);
    };
    document.addEventListener("dragstart", onDocumentDragStart);
    document.addEventListener("dragend", onDocumentDragEnd);
    document.addEventListener("drop", onDocumentDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDocumentDragStart);
      document.removeEventListener("dragend", onDocumentDragEnd);
      document.removeEventListener("drop", onDocumentDragEnd);
    };
  }, [noWorkspaces]);

  function onZoneDragOver(e: DragEvent): void {
    // Without a preventDefault here the browser never fires `drop`, and a file
    // drag or dockview's tab drag must stay untouched (the one-MIME rule).
    if (!acceptsSubshellDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHint(true);
  }

  function onZoneDragLeave(e: DragEvent): void {
    // Crossings into child rows fire dragleave too; only an exit to outside
    // the section clears the hint (the drop areas' own test).
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropHint(false);
  }

  /** Files the dragged pane into a fresh window and enters it — the split's
   * create-with-pane call, checked the way the split checks it. */
  async function createAround(subshellId: string, name: string): Promise<void> {
    createInFlight.current = true;
    setCreating(true);
    // The error is NOT cleared here: a retry stays visible with its busy
    // treatment while in flight, and a fresh drop over a standing banner
    // keeps the old words until its own attempt resolves.
    try {
      const workspace = await apiPost<WorkspaceRow>("/api/workspaces", { name, subshellId });
      // The response is CHECKED, not trusted: a server older than this page
      // silently drops `subshellId` and answers with an empty window — take
      // the husk back out and say the server is behind (lib/split-workspace-
      // refusal is that rule, shared with the split button).
      const refusal = splitWorkspaceRefusal(workspace);
      if (refusal) {
        await apiFetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" }).catch(() => {});
        throw new Error(refusal);
      }
      // Cleared on SUCCESS only, so the Retry button's busy state is real:
      // the banner stays on screen with the in-flight treatment until this
      // attempt actually lands, and a failure simply overwrites its words.
      setCreateError(null);
      lastDrop.current = null;
      // The rail tree renders from the LIST and the destination's dock from
      // the per-workspace detail: the membership trio wakes both, so the
      // branch for the window you land in is never missing.
      await invalidate();
      // The pane the drop just filed is the tab to show on arrival.
      armPaneFocusOnArrive(subshellId);
      await navigate({ to: "/workspaces/$id", params: { id: workspace.id } });
    } catch (err) {
      setCreateError(splitCreateFailureMessage(err));
    } finally {
      createInFlight.current = false;
      setCreating(false);
      setDropHint(false);
    }
  }

  function onZoneDrop(e: DragEvent): void {
    const subshellId = readSubshellDrag(e.dataTransfer);
    if (subshellId === null) return;
    e.preventDefault();
    setDropHint(false);
    // A second release while one create is in flight is inert, not a
    // duplicate window: the in-flight guard, not a toast, makes it so.
    if (createInFlight.current) return;
    // Named after the pane the way the split names it; the date stamp covers
    // a row the list has not delivered yet.
    const name = subshells.data?.find((row) => row.id === subshellId)?.name || defaultWorkspaceName();
    lastDrop.current = { id: subshellId, name };
    void createAround(subshellId, name);
  }

  const pickerRow = (
    <div className="flex min-w-0 items-center gap-2">
      <Select
        items={[
          ...rows.map((row) => ({ value: row.id, label: row.name })),
          { value: NEW_WORKSPACE, label: "New workspace" },
        ]}
        value={active?.id ?? null}
        onValueChange={(id) => {
          if (id === NEW_WORKSPACE) {
            quickAdd.openNewWorkspace();
            onQuickAdd?.();
            return;
          }
          if (id) void navigate({ to: "/workspaces/$id", params: { id } });
        }}
      >
        <SelectTrigger aria-label="Switch workspace" className="h-7 min-w-0 flex-1 px-2 py-0.5 text-detail">
          <SelectValue placeholder="Choose a workspace" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {rows.map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {row.name}
              </SelectItem>
            ))}
          </SelectGroup>
          {/* With rows, the divider separates the groups. With none, the row
              stands alone and takes no extra class: the List's own p-1 then
              insets it 4px from every popup edge, uniform. Any py here would
              stack on top and the vertical gap would outrun the sides. */}
          <SelectGroup className={cn(rows.length > 0 ? "mt-1 border-t pt-1" : null)}>
            <SelectItem value={NEW_WORKSPACE}>
              <span className="flex items-center gap-2">
                <Plus className="size-4" />
                New workspace
              </span>
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {active && <WorkspaceActionsMenu key={active.id} workspace={active} />}
      {headerEnd}
    </div>
  );

  const memberArea = (
    <WorkspaceSidebarDropArea kind="add" className="flex max-h-[45%] shrink-0 flex-col">
      <div className="min-h-0 overflow-y-auto px-1 pb-1">
        {active && (
          <WorkspaceActionsMenu workspace={active}>
            <WorkspaceBranch
              workspace={active}
              expanded
              active={workspaceIdFromPath(location.pathname) === active.id || standaloneId !== null}
              collapsible={false}
              droppable={false}
              forceOpen={false}
              onToggle={() => {}}
              focusedId={standaloneId ?? focusedId}
              labelsFor={labelsFor}
            />
          </WorkspaceActionsMenu>
        )}
        {standalone && <SubshellRecentRow subshell={standalone} focused {...labelsFor(standalone)} />}
        {!workspaces.isLoading && !workspaces.isError && !active && !standalone && (
          <p className="px-3 text-detail text-muted-foreground">
            {workspaceIdFromPath(location.pathname)
              ? "This workspace is no longer available."
              : "Select a workspace or drag a subshell here to get started."}
          </p>
        )}
        {subshells.isError && (
          <ListLoadError message="Couldn’t load subshells." retry={subshells.refetch} busy={subshells.isFetching} />
        )}
      </div>
    </WorkspaceSidebarDropArea>
  );

  return (
    <WorkspaceSidebarDrag workspace={active}>
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex shrink-0 items-center gap-2 text-detail text-muted-foreground">
          <span aria-hidden="true" className="w-3 border-t" />
          <span>Workspace</span>
          <span aria-hidden="true" className="flex-1 border-t" />
        </div>
        {workspaces.isLoading && <p className="px-3 text-detail text-muted-foreground">Loading workspaces…</p>}
        {workspaces.isError && (
          <ListLoadError message="Couldn’t load workspaces." retry={workspaces.refetch} busy={workspaces.isFetching} />
        )}
        {noWorkspaces ? (
          // The whole Workspace area (picker and empty state together — the
          // combobox button alone would be a sliver too small to aim at) is
          // the create-a-workspace drop target while there is no workspace.
          // The resting section stays clean. A subshell drag in flight puts
          // a dashed ring on the area and the solid primary ring shows once
          // the pointer is over it; the centered label rides the WHOLE
          // gesture, not just the hover (operator rulings 2026-10-20).
          // biome-ignore lint/a11y/noStaticElementInteractions: MIME-scoped HTML5 drop target; a plain click on a subshell row files it the same way, and the picker's New workspace row opens the dialog
          <div
            data-workspace-drop="create"
            className={cn(
              "relative flex min-w-0 flex-col gap-1",
              dragArmed && !dropHint && "rounded-lg border border-border border-dashed",
              dropHint && "rounded-lg border border-primary border-solid",
            )}
            onDragOver={onZoneDragOver}
            onDragLeave={onZoneDragLeave}
            onDrop={onZoneDrop}
          >
            {pickerRow}
            {memberArea}
            {createError && (
              // A failed create keeps its own words on the section that
              // failed, with a Retry, instead of quietly going back to the
              // empty copy (the ListLoadError idiom the reads beside it use).
              <ListLoadError
                message={createError}
                retry={() => {
                  const last = lastDrop.current;
                  if (last && !createInFlight.current) void createAround(last.id, last.name);
                }}
                busy={creating}
              />
            )}
            {(dragArmed || dropHint) && (
              // The centered label rides the whole gesture, not just the
              // hover: armed anywhere by a subshell-MIME drag, and one
              // element across the armed→hover transition, so role="status"
              // announces once.
              <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-md border border-primary border-solid bg-accent/95 p-3 text-center text-detail">
                <span role="status">Drop to create a workspace</span>
              </div>
            )}
          </div>
        ) : (
          <>
            {pickerRow}
            {memberArea}
          </>
        )}
        <WorkspaceSidebarDropArea kind="remove" className="mt-2 flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 pb-2 text-detail text-muted-foreground">
            <span aria-hidden="true" className="w-3 border-t" />
            <span>Subshells</span>
            <span aria-hidden="true" className="flex-1 border-t" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <AllSubshellsSection workspaceId={active?.id} excludeIds={memberIds} onAction={onQuickAdd} />
          </div>
        </WorkspaceSidebarDropArea>
      </div>
    </WorkspaceSidebarDrag>
  );
}
