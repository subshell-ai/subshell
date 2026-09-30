import { apiPost } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { joinPromptBlocks, type PromptBlock, presetBlocksToWire, promptLaunchMissed } from "@/lib/prompt-stack";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/** The fields the shared new-subshell form collects. */
export interface CreateSubshellInput {
  /** Agent (plugin) the subshell launches — the one required choice */
  harnessId: string;
  /**
   * Optional preset the subshell launches from; null/absent is a real
   * presetless launch (spec 2026-09-13 §2.2), not a mapping onto a seeded row.
   */
  presetId?: string | null;
  /** Absolute working directory the harness starts in */
  workingDir: string;
  /**
   * Optional display name; blank or absent means "default to date/time".
   * The launch FORM no longer collects one (naming a subshell before it
   * exists is a decision about something the user has not seen); the clone
   * dialog still does, because naming the copy is the whole point there.
   */
  name?: string;
  /**
   * Node picked in the form; "" = no valid choice yet (blocks submit upstream).
   */
  nodeId?: string;
  /** The prompt stack, joined into `prompt` when non-empty (spec
   *  2026-09-28; the launch form's checkbox was retired 2026-09-30 - the
   *  blocks ARE the switch). */
  promptBlocks?: PromptBlock[];
  /** Create a preset from these values before launching (ruling 2026-09-30). */
  saveAsPreset?: boolean;
  /** Its name; the form gates submit on it while `saveAsPreset` is set. */
  presetName?: string;
}

/**
 * The POST body for a fresh subshell — built in one place because `/new` and
 * the workspace dialog used to duplicate it byte for byte. A blank or absent
 * name is sent as `undefined` so the backend applies its date/time default,
 * and a null/absent preset is sent as no `presetId` at all — the presetless
 * launch. Remote launch is real (spec 2026-08-31 §6.6): the picked node id is
 * posted as-is — INCLUDING "local" (spec 2026-09-02 §3: the visible pick
 * always wins; the server precedence is body → local → lone-online
 * auto-pick). An absent/"" pick still sends no nodeId — legacy and mobile
 * callers keep the server's resolve ladder.
 * @param input - The collected form values
 * @returns The JSON body for `POST /api/subshells`
 */
export function toSubshellCreateBody({
  harnessId,
  presetId,
  workingDir,
  name,
  nodeId,
  promptBlocks,
}: CreateSubshellInput): {
  harnessId: string;
  presetId?: string;
  workingDir: string;
  name?: string;
  nodeId?: string;
  prompt?: string;
} {
  // The joined stack when it is non-empty. With a PRESET
  // chosen and the stack emptied (nothing added, or every copied block removed
  // the prefill), the launch says "none" OUTRIGHT with `prompt: ""`: the
  // server falls back to the preset's own blocks for an ABSENT field (spec
  // 2026-09-29-preset-launch-fields), and an empty string is what distinguishes
  // "the user said none" from "the user said nothing" (the manager's trim gate
  // types nothing, `promptLaunchMissed` needs blocks, so the empty override is
  // silent end to end). Presetless, an untouched form still sends no field.
  const joined = promptBlocks != null && promptBlocks.length > 0 ? joinPromptBlocks(promptBlocks) : null;
  const prompt = joined ?? (presetId != null ? "" : undefined);
  return {
    harnessId,
    presetId: presetId ?? undefined,
    workingDir,
    name: name?.trim() || undefined,
    nodeId: nodeId ? nodeId : undefined,
    prompt,
  };
}

/**
 * Creates a subshell: the single `POST /api/subshells` implementation shared
 * by the `/new` page and the workspace's add-subshell dialog. On success it
 * invalidates the subshells list, so the created subshell shows up wherever
 * the list is open even when the caller's follow-up step (adding a pane,
 * navigating) fails afterwards. What happens after creation — navigate to
 * the subshell, or attach it to a workspace — stays with the caller.
 */
export function useCreateSubshell() {
  const queryClient = useQueryClient();
  return useMutation({
    // `promptDelivered: false` is honest "started, prompt did not land": the
    // caller can point at the inject action instead of assuming the task went in.
    mutationFn: async (input: CreateSubshellInput) => {
      // The checkbox's promise first, so a failed preset POST never launches
      // an unremembered subshell (ruling 2026-09-30). SAVE-AS always creates
      // a NEW row: even when the form was copied from a preset, the edits
      // belong to the launch, and presets are never written back.
      const saved =
        input.saveAsPreset === true
          ? await apiPost<{ id: string }>("/api/presets", {
              harnessId: input.harnessId,
              name: (input.presetName ?? "").trim(),
              nodeId: input.nodeId && input.nodeId !== "" ? input.nodeId : null,
              workingDir: input.workingDir,
              promptBlocks: presetBlocksToWire(input.promptBlocks ?? []),
            })
          : null;
      return apiPost<{ id: string; promptDelivered?: boolean }>(
        "/api/subshells",
        toSubshellCreateBody(saved === null ? input : { ...input, presetId: saved.id }),
      );
    },
    onSuccess: (created, input) => {
      // One gate for all four launch surfaces (the form is shared): the
      // server answers `promptDelivered: false` for "no prompt" too, so the
      // warning may only ride a launch that actually stacked one.
      if (promptLaunchMissed(input.promptBlocks, created.promptDelivered)) {
        toast.warning('The prompt did not land. Use "Inject prompt" to type it in.');
      }
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      // The new preset row belongs in every preset list the app has open.
      if (input.saveAsPreset === true) void queryClient.invalidateQueries({ queryKey: ["presets"] });
      // The create touched the recent-paths row for its launch node — every
      // scoped recents cache (["recent-paths"] and ["recent-paths", nodeId])
      // is stale the moment a subshell launches somewhere.
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });
}
