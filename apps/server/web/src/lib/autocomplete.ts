/** One candidate in an autocomplete dropdown. */
export interface Suggestion {
  /** The value committed when the suggestion is picked */
  value: string;
  /** Secondary text shown beside the value (what it does) */
  detail?: string;
}

/**
 * Filters suggestions for the current query: case-insensitive substring
 * match, prefix matches ranked first, original order preserved within each
 * rank. An empty query returns everything.
 */
export function filterSuggestions(query: string, items: Suggestion[]): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const prefix: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const item of items) {
    const value = item.value.toLowerCase();
    if (value.startsWith(q)) prefix.push(item);
    else if (value.includes(q)) contains.push(item);
  }
  return [...prefix, ...contains];
}
