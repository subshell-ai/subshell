import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "@/lib/api";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/** The fields the shared new-subshell form collects. */
export interface CreateSubshellInput {
  /** Profile the subshell launches from */
  profileId: string;
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
   * Optional so legacy callers keep compiling.
   */
  nodeId?: string;
}

/**
 * The POST body for a fresh subshell — built in one place because `/new` and
 * the workspace dialog used to duplicate it byte for byte. A blank or absent
 * name is sent as `undefined` so the backend applies its date/time default.
 * Remote launch is real (spec 2026-08-31 §6.6): the picked node id is posted
 * as-is — INCLUDING "local" (spec 2026-09-02 §3: the visible pick always
 * wins over a profile pin; the server precedence puts body nodeId first).
 * An absent/"" pick still sends no nodeId — legacy and mobile callers keep
 * the server's resolve ladder (pin → local → lone-online auto-pick).
 * @param input - The collected form values
 * @returns The JSON body for `POST /api/subshells`
 */
export function toSubshellCreateBody({ profileId, workingDir, name, nodeId }: CreateSubshellInput): {
  profileId: string;
  workingDir: string;
  name?: string;
  nodeId?: string;
} {
  return {
    profileId,
    workingDir,
    name: name?.trim() || undefined,
    nodeId: nodeId ? nodeId : undefined,
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
    mutationFn: (input: CreateSubshellInput) => apiPost<{ id: string }>("/api/subshells", toSubshellCreateBody(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      // The create touched the recent-paths row for its launch node — every
      // scoped recents cache (["recent-paths"] and ["recent-paths", nodeId])
      // is stale the moment a subshell launches somewhere.
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });
}
