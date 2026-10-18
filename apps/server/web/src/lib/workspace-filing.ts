import { apiFetch, apiPost } from "@internal/node-admin";
import { lastWorkspaceId, rememberLastWorkspace } from "@/lib/current-workspace";
import { armPaneFocusOnArrive } from "@/lib/workspace-focus";
import { defaultWorkspaceName } from "@/lib/workspace-name";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * File a just-launched pane into a workspace, the client half of every
 * launch raised with no workspace on screen (spec 2026-10-17): you are
 * always in a workspace, and a workspace you ALREADY have comes first — the
 * one this device last visited, when it still exists, else the most recently
 * touched. Only an instance with no workspace at all (a first launch) builds
 * one around the pane, the create-with-pane shape the split uses.
 *
 * Returns the workspace the pane now sits in, or null when no filing
 * happened — the caller then lands on the plain subshell page, which is
 * honest: the launch itself worked, and clicking the pane later files it the
 * same way. A LIST read that FAILS is not an answer of "no workspaces":
 * filing on that guess opens a duplicate window beside the one you already
 * have (the dashboard rule keeps error and empty distinct), so the read
 * retries once and a second failure leaves the pane unfiled.
 *
 * The pane's own tab is armed for arrival focus before returning: a launch
 * that files into a workspace already holding tabs must show the tab it just
 * opened, not whichever one the view happened to select — the phone's strip
 * renders only the selected tab's terminal, so the unselected new pane would
 * never even attach.
 *
 * Cache wakes (the subshells list, the membership trio) stay with the
 * callers, which know what else they changed; this is the network ladder.
 */
export async function fileLaunchedPane(subshellId: string, name?: string): Promise<string | null> {
  let homes: WorkspaceRow[] | null = null;
  for (let attempt = 0; attempt < 2 && homes === null; attempt += 1) {
    const list = await apiFetch<WorkspaceRow[]>("/api/workspaces").catch(() => null);
    // The list is a server contract, not a trusted value here: anything
    // that is not an array means "nothing known", the same as an error.
    if (Array.isArray(list)) homes = list;
  }
  if (homes === null) return null;
  const remembered = lastWorkspaceId();
  const join =
    homes.find((h) => h.id === remembered) ?? [...homes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (join) {
    // The idempotent add-pane call: a duplicate answer is the same tab, so a
    // racing order of create-then-attach is never a second filing. A failure
    // (the row retired between read and write, or a request that never
    // answered) falls through to opening a new one — an accepted trade on a
    // lost response, since the pane-add may have committed server-side and
    // the fresh window then files the same pane twice.
    const attached = await apiPost<{ id: string }>(`/api/workspaces/${join.id}/panes`, { subshellId }).catch(
      () => null,
    );
    if (attached) {
      rememberLastWorkspace(join.id);
      armPaneFocusOnArrive(subshellId);
      return join.id;
    }
  }
  // The fresh window is named after the pane the way the split names it: the
  // name the person typed, when they typed one; the server's date/time
  // default lands on the ROW, and this is the client-side counterpart.
  const fresh = await apiPost<{ id: string }>("/api/workspaces", {
    name: name?.trim() || defaultWorkspaceName(),
    subshellId,
  }).catch(() => null);
  if (fresh) {
    rememberLastWorkspace(fresh.id);
    armPaneFocusOnArrive(subshellId);
    return fresh.id;
  }
  return null;
}
