/** Literal, case-insensitive search, applied only to rows the caller may see. */
export function matchesListQuery(query: string | undefined, ...values: (string | null | undefined)[]): boolean {
  const needle = query?.trim().toLowerCase() ?? "";
  return !needle || values.some((value) => value?.toLowerCase().includes(needle));
}
