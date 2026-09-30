import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromptDraft } from "@/lib/prompt-form";
import type { PromptStackDraft } from "@/lib/prompt-stack-form";
import type { StacksView } from "@/lib/prompt-stacks";
import type { PromptsView } from "@/lib/prompts";

/**
 * The saved-prompt library (spec 2026-09-28). One key, one URL: the page,
 * the launch-form picker, and the inject dialog all read the SAME list, the
 * way every preset surface reads `["presets"]`. Mutations invalidate rather
 * than patch: unlike the preset selection (which the launch form guards
 * against a cache that has not refetched yet), no picker selects a prompt by
 * id from this cache in the same turn it was created.
 *
 * Stacks (spec 2026-09-29) ride their own key and URL, but the two lists are
 * ENTANGILED by membership: every prompt mutation also invalidates the stacks
 * (a member's text shows through, a delete empties the membership row, an
 * unshare drops it from every viewer's copy), while a stack mutation is
 * invisible to the prompt rows (membership never lands on a prompt).
 */

export const PROMPTS_QUERY_KEY = ["prompts"] as const;
export const PROMPT_STACKS_QUERY_KEY = ["prompt-stacks"] as const;

export function usePrompts() {
  return useQuery({
    queryKey: PROMPTS_QUERY_KEY,
    queryFn: () => apiFetch<PromptsView>("/api/prompts"),
  });
}

/** `enabled` lets a consumer that cannot show stacks (the stack editor's
 *  picker, which must not nest) skip the request entirely rather than fetch
 *  a list it will never render. */
export function usePromptStacks(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: PROMPT_STACKS_QUERY_KEY,
    queryFn: () => apiFetch<StacksView>("/api/prompts/stacks"),
    enabled: opts?.enabled ?? true,
  });
}

/** Both keys, the prompt mutations' rule: membership reads through to stacks. */
function useInvalidateLibrary(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PROMPTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: PROMPT_STACKS_QUERY_KEY }),
    ]).then(() => undefined);
}

/** `POST /api/prompts` — the dialog decides whether the row matters back. */
export function useCreatePrompt() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (draft: PromptDraft) => apiPost("/api/prompts", draft),
    onSuccess: () => void invalidate(),
  });
}

/** `PUT /api/prompts/:id` — the draft is a complete replacement of the fields. */
export function useUpdatePrompt() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: PromptDraft }) =>
      apiFetch(`/api/prompts/${id}`, { method: "PUT", body: JSON.stringify(draft) }),
    onSuccess: () => void invalidate(),
  });
}

/** `DELETE /api/prompts/:id` */
export function useDeletePrompt() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/prompts/${id}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
}

/** `POST /api/prompts/stacks` */
export function useCreatePromptStack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: PromptStackDraft) => apiPost("/api/prompts/stacks", draft),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROMPT_STACKS_QUERY_KEY }),
  });
}

/**
 * `PUT /api/prompts/stacks/:id` — a PATCH in the real sense: absent fields
 * are untouched, and `items`, WHEN PRESENT, is the full ordered set (the
 * server preserves members the caller cannot see across that replace). The
 * share toggle sends the flag alone, so flipping it rewrites no membership.
 */
export function useUpdatePromptStack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PromptStackDraft> }) =>
      apiFetch(`/api/prompts/stacks/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROMPT_STACKS_QUERY_KEY }),
  });
}

/** `DELETE /api/prompts/stacks/:id` — member prompts survive; membership goes. */
export function useDeletePromptStack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/prompts/stacks/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROMPT_STACKS_QUERY_KEY }),
  });
}
