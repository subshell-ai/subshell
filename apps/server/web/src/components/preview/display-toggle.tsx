import { apiFetch, errMessage } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { VirtualDisplayField } from "@/components/subshell-picker/virtual-display-field";
import { useNodes } from "@/hooks/use-nodes";
import { type PreviewInfo, previewInfoQueryKey } from "@/hooks/use-subshell-preview";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { confirmDisableVirtualDisplay, confirmEnableVirtualDisplay } from "@/lib/subshell-confirmations";
import type { SubshellView } from "@/types/subshell";

/** The launch form's display size, reused here: the picker offers a default, not a designer. */
const DEFAULT_DISPLAY_SIZE = { width: 1280, height: 800 } as const;

/** The access limit, verbatim: the box covers both directions with it. */
const ACCESS_LIMIT = "Turning a virtual display on or off needs edit access to this subshell.";

/**
 * The picker's Virtual display row (spec 2026-11-06). Off: the launch form's
 * own control, checked means "enable it" - the click confirms (the pane
 * restarts) and PUTs the request the field selected, with the launch form's
 * default size. On: unchecked means "turn it off" after its own confirm; the
 * display's processes close and the node frees them, the pane keeps running.
 * Both paths invalidate the preview and row caches the moment they land; the
 * restart's own live frames and the info poll make the row honest after. A
 * refused flip leaves the server's own sentence in a red line under the row.
 */
export function DisplayToggle({
  subshellId,
  subshell,
  info,
  onBusyChange,
}: {
  subshellId: string;
  /**
   * The row reads only these fields of the subshell (ruling: a structural
   * subset, so callers pass their loaded row and tests type without casts).
   * `alive` is the enable confirmation's liveness branch: the flip on a dead
   * row revives it, and the prompt must not claim to stop a running process.
   */
  subshell: Pick<SubshellView, "id" | "name" | "nodeId" | "access" | "alive">;
  info: PreviewInfo;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useNodes();
  const node = data?.nodes.find((n) => n.id === subshell.nodeId) ?? null;
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const on = info.screen !== null;
  // The viewer's access limit, if any: it disables the box in BOTH directions
  // through the field's `disabledReason` channel.
  const accessLimit = subshell.access === "view" ? ACCESS_LIMIT : undefined;
  const mutate = useMutation({
    // PUT awaits the full in-place restart server-side (kill + relaunch), so
    // the caches settling after it is the whole sync story - the same promise
    // discipline use-subshell-mutations' restart keeps.
    mutationFn: (enable: boolean) =>
      enable
        ? apiFetch(`/api/subshells/${encodeURIComponent(subshellId)}/screen`, {
            method: "PUT",
            body: JSON.stringify({ ...DEFAULT_DISPLAY_SIZE, ...(provider ? { provider } : {}) }),
          })
        : apiFetch(`/api/subshells/${encodeURIComponent(subshellId)}/screen`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: previewInfoQueryKey(subshellId) });
      // The row itself is the toggle's other read (the header badge, the
      // sidebar), and the restart moves the pane through workspaces: same
      // refresh set use-subshell-mutations' restart uses, for the same reason.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
    // A refused flip says so: one honest red line under the row, in the
    // server's own words. No retry machinery, no toast.
    onError: (err) => setError(errMessage(err, "Couldn't change the virtual display.")),
    // The skeleton's onFinally: this @tanstack/react-query exposes the same
    // settle point as onSettled, which every mutation hook in the app uses.
    onSettled: () => onBusyChange?.(false),
  });
  async function flip(wantOn: boolean) {
    // A flip in flight already owns this control; a second one (a DELETE after
    // a still-running PUT, which awaits a whole restart) would fight it. The
    // box is disabled meanwhile (the pending-first `disabledReason` below),
    // but a click can land in the same tick the pending flag was set, so the
    // action guards itself too.
    if (mutate.isPending) return;
    setError(null);
    onBusyChange?.(true);
    const ok = wantOn
      ? await confirmEnableVirtualDisplay(subshell.alive)
      : await confirmDisableVirtualDisplay(subshell.name);
    if (!ok) {
      onBusyChange?.(false);
      return;
    }
    mutate.mutate(wantOn);
  }
  return (
    <>
      <VirtualDisplayField
        node={node}
        id={`preview-display-${subshellId}`}
        checked={on}
        // The field's own availability `reason` disables the box when the node
        // cannot serve a display; `disabledReason` covers the viewer's access.
        onChange={(checked) => void flip(Boolean(checked))}
        provider={provider}
        onProviderChange={on ? undefined : setProvider}
        // Pending-first: an in-flight flip (a PUT that awaits a whole restart)
        // is the reason right now, and it overrides the access sentence rather
        // than concatenating with it. A view-only viewer can't start a flip, so
        // pending never reaches them; once settled, the access story returns.
        disabledReason={mutate.isPending ? "Wait for the display change in progress to finish." : accessLimit}
        // The pane's node is fixed and named in the dialog's header, so the
        // launch form's "Choose a node first." would be a non sequitur here;
        // when the viewer cannot see the node there is no readiness to read,
        // and the override says what is actually true instead. During the load
        // window `data` is still undefined, so nothing yet blames sharing: the
        // dialog's own loading phrase reads until the list lands and the node
        // is genuinely absent.
        reasonOverride={
          node
            ? undefined
            : data === undefined
              ? "Checking this node…"
              : "This pane's node isn't shared with you, so the dashboard can't check its display options from here. Turning off a display that's on still works."
        }
      />
      {error && (
        <p role="alert" className="text-destructive text-detail">
          {error}
        </p>
      )}
    </>
  );
}
