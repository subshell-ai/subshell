import { useMemo } from "react";
import { useNodes } from "@/hooks/use-nodes";
import { type TrustNotice, trustNoticesFor } from "@/lib/trust-notices";
import type { SubshellView } from "@/types/subshell";

/**
 * The disclosure notices for one subshell, resolved against the caller's
 * visible nodes.
 *
 * The node lookup is why this is a hook rather than a bare call: "is this
 * someone else's machine?" is answered by the caller's OWN access to the node
 * (`access !== "owner"`), which only the nodes list carries. `useNodes` is
 * already mounted across the app and cached by TanStack Query, so this adds no
 * request on the subshell pages.
 *
 * @param subshell - the subshell in view; undefined while it loads (no notices)
 */
export function useTrustNotices(subshell: SubshellView | undefined): TrustNotice[] {
  const { data } = useNodes();
  return useMemo(() => trustNoticesFor(subshell, data?.nodes), [subshell, data?.nodes]);
}
