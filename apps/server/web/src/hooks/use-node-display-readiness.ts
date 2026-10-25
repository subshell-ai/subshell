import { apiFetch, type Node } from "@internal/node-admin";
import { type PreviewDisplayReadiness, parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { useQuery } from "@tanstack/react-query";

export function virtualDisplayReason(node: Node | null, readiness?: PreviewDisplayReadiness): string | undefined {
  if (!node) return "Choose a machine first.";
  if (node.os !== "linux") return "Virtual displays are available on Linux machines only.";
  if (node.viewsEnabled !== true) return "Turn on Allow apps and screens in this machine's node settings first.";
  if (!readiness) return "Checking virtual display requirements…";
  if (!readiness.supported) return "Virtual displays are available on Linux machines only.";
  if (readiness.missing.length) {
    return "Required virtual display programs are missing on this machine.";
  }
  return undefined;
}

/** Share the machine check and refusal reasons between node settings and launch. */
export function useNodeDisplayReadiness(node: Node | null) {
  const shouldCheck = Boolean(node && node.os === "linux" && node.viewsEnabled === true);
  const check = useQuery({
    queryKey: ["preview-display-readiness", node?.id],
    enabled: shouldCheck,
    queryFn: async () => {
      const data = parsePreviewDisplayReadiness(await apiFetch<unknown>(`/api/nodes/${node?.id}/display-readiness`));
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
        : virtualDisplayReason(node, check.data);
  const needsSetup =
    shouldCheck && !check.isFetching && !check.isError && check.data?.supported && check.data.missing.length > 0;
  return { check, reason, needsSetup, shouldCheck };
}
