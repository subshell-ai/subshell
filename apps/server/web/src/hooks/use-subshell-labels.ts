import { useCallback } from "react";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { FALLBACK_NODE_ID, nodeLabelFor } from "@/lib/subshell-node-groups";
import type { SubshellView } from "@/types/subshell";

/** Resolve row tooltip labels from shared cached lists. */
export function useSubshellLabels() {
  const nodes = useNodes();
  const plugins = useInstancePlugins();
  const presets = usePresets();
  return useCallback(
    (sub: SubshellView) => ({
      nodeLabel: nodeLabelFor(sub.nodeId || FALLBACK_NODE_ID, nodes.data?.nodes, nodes.data === undefined).label,
      agentLabel: plugins.data?.plugins.find((plugin) => plugin.id === sub.harnessId)?.name ?? sub.harnessId,
      presetLabel:
        sub.presetId == null
          ? undefined
          : (presets.data?.find((preset) => preset.id === sub.presetId)?.name ?? sub.presetId),
    }),
    [nodes.data, plugins.data, presets.data],
  );
}
