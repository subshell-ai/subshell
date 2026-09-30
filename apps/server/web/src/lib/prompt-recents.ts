import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * "Recently used" memory for the prompt picker (operator ruling 2026-09-29):
 * the prompts and stacks you actually pick, most recent first, kept in this
 * browser across sessions. Only re-openable rows are tracked — a saved prompt
 * (by `promptId`) or a stack (by `stackId`). A "Write your own..." custom block
 * carries no id to re-offer, so it is never remembered.
 *
 * The list is deliberately LONGER than what the picker shows: the header leads
 * with only a few, but the backlog means a still-existing item surfaces when a
 * newer pick is deleted or unshared out of the offer. Storage is best-effort:
 * blocked or malformed reads fall back to empty, never throwing into a render.
 */

export interface RecentPick {
  kind: "saved" | "stack";
  id: string;
}

const KEY = "subshell/recent-prompt-picks";
const MAX_TRACKED = 24;

/** Most-recent-first picks, read defensively (a manual edit or a future shape
 *  yields the empty list rather than poisoning the picker). */
export function loadRecentPicks(): RecentPick[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentPick =>
          !!e &&
          typeof e === "object" &&
          ((e as RecentPick).kind === "saved" || (e as RecentPick).kind === "stack") &&
          typeof (e as RecentPick).id === "string",
      )
      .slice(0, MAX_TRACKED);
  } catch {
    return [];
  }
}

/** Move the picked block's identity to the head, de-dupe, bound, persist, and
 *  return the new list so the caller reflects it without another read. Custom
 *  blocks (no id) are ignored. */
export function recordRecentPick(block: PromptBlock): RecentPick[] {
  const current = loadRecentPicks();
  const entry: RecentPick | null =
    block.kind === "saved" && block.promptId
      ? { kind: "saved", id: block.promptId }
      : block.kind === "stack" && block.stackId
        ? { kind: "stack", id: block.stackId }
        : null;
  if (entry === null) return current;
  const next = [entry, ...current.filter((e) => !(e.kind === entry.kind && e.id === entry.id))].slice(0, MAX_TRACKED);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: the memory is best-effort, the pick still lands */
  }
  return next;
}
