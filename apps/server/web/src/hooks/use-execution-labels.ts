import type { Node } from "@internal/node-admin";
import { useMemo } from "react";
import { useSshSessions } from "@/hooks/use-ssh-runtime";

/** Display-only names for enrolled machines and the viewer's SSH destinations. Never used for launch authorization. */
export function useExecutionLabels(
  nodes: readonly Node[] | undefined,
): readonly Pick<Node, "id" | "name">[] | undefined {
  const sessions = useSshSessions();
  return useMemo(() => {
    if (nodes === undefined && sessions.data === undefined) return undefined;
    return [
      ...(nodes ?? []),
      ...(sessions.data?.sessions ?? []).map((session) => ({
        id: session.runtimeNodeId,
        name: `SSH · ${session.alias}`,
      })),
    ];
  }, [nodes, sessions.data]);
}
