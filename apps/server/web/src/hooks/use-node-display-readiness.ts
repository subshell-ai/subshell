import { apiFetch, type Node } from "@internal/node-admin";
import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  type PreviewDisplayReadiness,
  parsePreviewDisplayReadiness,
} from "@internal/subshell-protocol";
import { useQuery } from "@tanstack/react-query";

export function virtualDisplayReason(
  node: Node | null,
  readiness?: PreviewDisplayReadiness,
  provider?: string,
): string | undefined {
  if (!node) return "Choose a node first.";
  if (node.virtualDisplayEnabled !== true)
    return "Turn on Allow virtual displays in the selected node's settings first.";
  if (
    !(node.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER]).includes(
      provider ?? node.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
    )
  )
    return "This display provider is disabled on the selected node. Enable it in node settings or choose another provider.";
  if (!readiness) return "Checking virtual display requirements…";
  if (!readiness.supported) return "This virtual display provider does not support the selected node.";
  if (readiness.missing.length) {
    return "Virtual display requirements are missing on the selected node.";
  }
  return undefined;
}

/** Share the machine check and refusal reasons between node settings and launch. */
export function useNodeDisplayReadiness(node: Node | null, provider?: string, inspect = false) {
  const selected = provider ?? node?.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
  const allowed = (node?.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER]).includes(selected);
  const shouldCheck = Boolean(node && (inspect || (node.virtualDisplayEnabled === true && allowed)));
  const check = useQuery({
    queryKey: ["preview-display-readiness", node?.id, selected],
    enabled: shouldCheck,
    queryFn: async () => {
      const data = parsePreviewDisplayReadiness(
        await apiFetch<unknown>(`/api/nodes/${node?.id}/display-readiness?provider=${encodeURIComponent(selected)}`),
      );
      if (!data) throw new Error("Couldn't check virtual display requirements. Choose Recheck to try again.");
      return data;
    },
    retry: false,
    // Moving back to the form must not clear a display the user just selected.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const reason =
    shouldCheck && check.isFetching
      ? "Checking virtual display requirements…"
      : shouldCheck && check.isError
        ? check.error.message
        : virtualDisplayReason(
            inspect && node ? { ...node, virtualDisplayEnabled: true, virtualDisplayProviders: [selected] } : node,
            check.data,
            selected,
          );
  const needsSetup =
    shouldCheck && !check.isFetching && !check.isError && check.data?.supported && check.data.missing.length > 0;
  // A failed or pending probe is unknown, so it must not erase a user's choice.
  const unavailable = Boolean(
    node &&
      (node.virtualDisplayEnabled !== true ||
        !allowed ||
        (!check.isFetching && check.isSuccess && (!check.data.supported || check.data.missing.length > 0))),
  );
  return { check, reason, needsSetup, shouldCheck, unavailable };
}
