import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromptDraft } from "@/lib/prompt-form";
import type { PromptsView } from "@/lib/prompts";

/**
 * The saved-prompt library (spec 2026-09-28). One key, one URL: the page,
 * the launch-form picker, and the inject dialog all read the SAME list, the
 * way every preset surface reads `["presets"]`. Mutations invalidate rather
 * than patch: unlike the preset selection (which the launch form guards
 * against a cache that has not refetched yet), no picker selects a prompt by
 * id from this cache in the same turn it was created.
 */

export const PROMPTS_QUERY_KEY = ["prompts"] as const;

export function usePrompts() {
  return useQuery({
    queryKey: PROMPTS_QUERY_KEY,
    queryFn: () => apiFetch<PromptsView>("/api/prompts"),
  });
}

/** Invalidates the prompt list; the shared shape of `useInvalidatePresets`. */
export function useInvalidatePrompts(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: PROMPTS_QUERY_KEY });
}

/** `POST /api/prompts` — the dialog decides whether the row matters back. */
export function useCreatePrompt() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: (draft: PromptDraft) => apiPost("/api/prompts", draft),
    onSuccess: () => void invalidate(),
  });
}

/** `PUT /api/prompts/:id` — the draft is a complete replacement of the fields. */
export function useUpdatePrompt() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: PromptDraft }) =>
      apiFetch(`/api/prompts/${id}`, { method: "PUT", body: JSON.stringify(draft) }),
    onSuccess: () => void invalidate(),
  });
}

/** `DELETE /api/prompts/:id` */
export function useDeletePrompt() {
  const invalidate = useInvalidatePrompts();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/prompts/${id}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
}
