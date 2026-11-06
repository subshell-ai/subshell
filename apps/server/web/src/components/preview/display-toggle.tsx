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
   */
  subshell: Pick<SubshellView, "id" | "name" | "nodeId" | "access">;
  info: PreviewInfo;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useNodes();
  const node = data?.nodes.find((n) => n.id === subshell.nodeId) ?? null;
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const on = info.screen !== null;
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
    setError(null);
    onBusyChange?.(true);
    const ok = wantOn
      ? await confirmEnableVirtualDisplay(subshell.name)
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
        disabledReason={
          subshell.access === "view"
            ? "Turning a virtual display on or off needs edit access to this subshell."
            : undefined
        }
        // The pane's node is fixed and named in the dialog's header, so the
        // launch form's "Choose a node first." would be a non sequitur here;
        // when the viewer cannot see the node there is no readiness to read,
        // and the override says what is actually true instead.
        reasonOverride={
          node
            ? undefined
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
