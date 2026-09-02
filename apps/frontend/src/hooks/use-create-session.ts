import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "@/lib/api";
import { SESSIONS_QUERY_KEY } from "@/lib/query-keys";

/** The fields the shared new-session form collects. */
export interface CreateSessionInput {
  /** Profile the session launches from */
  profileId: string;
  /** Absolute working directory the harness starts in */
  workingDir: string;
  /** Optional display name; blank means "default to date/time" */
  name: string;
  /**
   * Node picked in the form; "" = no valid choice yet (blocks submit upstream).
   * Optional so legacy callers keep compiling.
   */
  nodeId?: string;
}

/**
 * The POST body for a fresh session — built in one place because `/new` and
 * the workspace dialog used to duplicate it byte for byte. A blank name is
 * sent as `undefined` so the backend applies its date/time default.
 * Remote launch is real (spec 2026-08-31 §6.6): a non-`local` pick is posted
 * as-is and the backend resolves/gates it (`resolveLaunchNode` — 404 for an
 * invisible node, 409 `NODE_OFFLINE` when the agent is down). An omitted or
 * `"local"` pick sends no `nodeId` at all: omission is the server's own
 * resolve path (pin → local → lone-online auto-pick), which explicit `local`
 * merely skips — so leaving it out whenever possible is the honest default.
 * @param input - The collected form values
 * @returns The JSON body for `POST /api/sessions`
 */
export function toSessionCreateBody({ profileId, workingDir, name, nodeId }: CreateSessionInput): {
  profileId: string;
  workingDir: string;
  name?: string;
  nodeId?: string;
} {
  return {
    profileId,
    workingDir,
    name: name.trim() || undefined,
    nodeId: nodeId && nodeId !== "local" ? nodeId : undefined,
  };
}

/**
 * Creates a session: the single `POST /api/sessions` implementation shared
 * by the `/new` page and the workspace's add-session dialog. On success it
 * invalidates the sessions list, so the created session shows up wherever
 * the list is open even when the caller's follow-up step (adding a pane,
 * navigating) fails afterwards. What happens after creation — navigate to
 * the session, or attach it to a workspace — stays with the caller.
 */
export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionInput) => apiPost<{ id: string }>("/api/sessions", toSessionCreateBody(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      // The create touched the recent-paths row for its launch node — every
      // scoped recents cache (["recent-paths"] and ["recent-paths", nodeId])
      // is stale the moment a session launches somewhere.
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });
}
