import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { currentWorkspaceId, rememberLastWorkspace } from "@/lib/current-workspace";
import { joinPromptBlocks, type PromptBlock, presetBlocksToWire, promptLaunchMissed } from "@/lib/prompt-stack";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { defaultWorkspaceName } from "@/lib/workspace-name";
import type { PresetRow } from "@/types/preset";

/** What a launch answers: the row's id, the prompt truth, and the workspace
 * this press opened for it (the landing's first pane; spec 2026-10-17). */
export interface CreatedSubshell {
  /** The new subshell's id */
  id: string;
  /** The server's name for the row (subshells are unnamed at launch today) */
  name: string;
  /** False when a prompt was asked for but did not reach the pane */
  promptDelivered?: boolean;
  /** The workspace this launch was filed into — the one on screen, or a
   fresh one opened around the pane when none was (spec 2026-10-17) */
  workspaceId?: string;
}

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
/**
 * `autoFile` (default true) is the "you are always in a workspace" rule: a
 * launch raised with no workspace on screen gets a workspace opened around
 * it. Callers that FILE the pane themselves — the add-a-pane dialog (its
 * `onAdd` attaches through the idempotent pane path, including the split's)
 * and the new-workspace dialog (which creates the workspace first) — pass
 * false, or the shared create would leave a second workspace holding the
 * same row.
 */
export function useCreateSubshell({ autoFile = true }: { autoFile?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    // `promptDelivered: false` is honest "started, prompt did not land": the
    // caller can point at the inject action instead of assuming the task went in.
    mutationFn: async (input: CreateSubshellInput): Promise<CreatedSubshell> => {
      // The checkbox's promise first, so a failed preset POST never launches
      // an unremembered subshell (ruling 2026-09-30). SAVE-AS always creates
      // a NEW row - presets are never written back - and it is a FAITHFUL
      // copy: when the form was copied from a preset, that row's settings
      // the form cannot see (env, flags, isolation, restart policy) ride
      // into the new row, so launching FROM the saved preset changes
      // nothing about the launch, and the saved preset reproduces exactly
      // the pane you are about to get (review round 3: a bare copy silently
      // dropped the picked preset's flags from the launch). Never copied:
      // the cross-comm switch - letting agents launch is an opt-in per row.
      let saved: { id: string } | null = null;
      if (input.saveAsPreset === true) {
        let source: PresetRow | null = null;
        if (input.presetId != null) {
          // The copy SOURCE is read before anything is created, and every
          // failure aborts the whole launch before the POST - a silent
          // fallback to the bare copy is how the settings-loss bug this
          // step fixes reads (review round 4; the named read error carries
          // the original as cause). The three column parses below see only
          // server-written JSON, so an unnamed SyntaxError stays unreachable.
          const rows = await apiFetch<PresetRow[]>("/api/presets").catch((err) => {
            throw new Error("Could not read your presets to save this launch. Try again.", { cause: err });
          });
          source = rows.find((r) => r.id === input.presetId) ?? null;
          if (source === null) {
            throw new Error("The preset you picked no longer exists. Pick again, or launch without saving.");
          }
        }
        saved = await apiPost<{ id: string }>("/api/presets", {
          harnessId: input.harnessId,
          name: (input.presetName ?? "").trim(),
          ...(source === null
            ? {}
            : {
                env: source.envJson === null ? undefined : (JSON.parse(source.envJson) as Record<string, string>),
                flags: source.flagsJson === null ? undefined : (JSON.parse(source.flagsJson) as string[]),
                settings:
                  source.settingsJson === null
                    ? undefined
                    : (JSON.parse(source.settingsJson) as Record<string, unknown>),
                configIsolation: source.configIsolation === 1,
                restartOnExit: source.restartOnExit === 1,
              }),
          nodeId: input.nodeId && input.nodeId !== "" ? input.nodeId : null,
          // TRIMMED like the preset editor's payload; the server refuses a
          // leading space and canSubmit only requires non-empty content.
          workingDir: input.workingDir.trim(),
          promptBlocks: presetBlocksToWire(input.promptBlocks ?? []),
        });
      }
      try {
        // Spec 2026-10-17: a launch raised while a workspace page is on screen
        // LANDS AS A TAB in it, server-side in the create's own write. With no
        // workspace on screen the pane starts ungrouped, which is what the
        // rail's Ungrouped branch and every bearer/MCP create already expect.
        // The workspace the dialog is adding to may differ from the page's
        // (the add-dialog's explicit flow keeps its own path: it launches,
        // then attaches through the idempotent add-pane call, and the server
        // treats the duplicate as the same tab, so the two orders agree).
        const filedInto = currentWorkspaceId();
        const created = await apiPost<Omit<CreatedSubshell, "workspaceId">>("/api/subshells", {
          ...toSubshellCreateBody(saved === null ? input : { ...input, presetId: saved.id }),
          ...(filedInto ? { workspaceId: filedInto } : {}),
        });
        // You are always in a workspace (operator ruling, spec 2026-10-17):
        // a launch raised with none on screen opens one around the pane it
        // just made, named after it, the same create-with-pane shape the
        // split uses. A failure here leaves a running ungrouped pane and the
        // plain detail landing, which is honest: the launch itself worked,
        // and clicking that pane later files it the same way.
        if (autoFile && !filedInto) {
          const fresh = await apiPost<{ id: string }>("/api/workspaces", {
            name: created.name || defaultWorkspaceName(),
            subshellId: created.id,
          }).catch(() => null);
          if (fresh) {
            rememberLastWorkspace(fresh.id);
            return { ...created, workspaceId: fresh.id };
          }
        }
        return created;
      } catch (err) {
        // A row this click created for a launch that did not happen is an
        // orphan: invisible (the list was never invalidated) and poisonous
        // (the unique-name index would refuse the retry). Take it back
        // before rethrowing; best-effort - the launch error is the story.
        // Accepted trade (review round 4): a client-side throw AFTER a
        // server-side success (slow remote spawn outliving the request)
        // would un-save a preset its running pane references - the same
        // timeout asymmetry the MCP layer documents; the repo tolerates a
        // nulled preset_id, and a visible leftover row is the worse half.
        if (saved !== null) {
          try {
            await apiFetch(`/api/presets/${saved.id}`, { method: "DELETE" });
          } catch {
            /* the launch error still surfaces; a leftover row stays visible at /presets */
          }
        }
        throw err;
      }
    },
    onSuccess: (created, input) => {
      // One gate for all four launch surfaces (the form is shared): the
      // server answers `promptDelivered: false` for "no prompt" too, so the
      // warning may only ride a launch that actually stacked one.
      if (promptLaunchMissed(input.promptBlocks, created.promptDelivered)) {
        toast.warning('The prompt wasn\'t entered. Use "Insert prompt" to type it in.');
      }
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      // A filed launch changed the workspace's pane list (and possibly retired
      // the landing's stale empty branch): the tree reads membership from the
      // workspace list, so it rides along.
      void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
      // The new preset row belongs in every preset list the app has open.
      if (input.saveAsPreset === true) void queryClient.invalidateQueries({ queryKey: ["presets"] });
      // The create touched the recent-paths row for its launch node — every
      // scoped recents cache (["recent-paths"] and ["recent-paths", nodeId])
      // is stale the moment a subshell launches somewhere.
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });
}
