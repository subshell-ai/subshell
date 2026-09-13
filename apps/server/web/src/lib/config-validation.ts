import { validateValue } from "@internal/server/config-values";
import type { ServerSettingKey } from "@/types/server-deployment";

/**
 * Why a value for `key` is unacceptable, or null when it is fine.
 *
 * **This is the SERVER'S validator, imported — not a copy of its rules.**
 * `commands/config-values.ts` is the one place that decides what a config
 * value may be, shared with `subshell-server configure` so the CLI and the
 * route cannot disagree; a browser-side reimplementation would be a third
 * opinion, and the one most likely to drift STRICTER and start refusing
 * values the server would have taken.
 *
 * Two things make the import sound rather than convenient. That module has no
 * imports at all — pure predicates over strings, no IO, no node built-ins — so
 * it bundles for a browser unchanged. And `apps/server/web` is AGPL like
 * `apps/server/api`, both being under `apps/server/**`, so a VALUE import
 * across that line is not the licence crossing `lint:licenses` polices; the
 * Apache packages are the ones that may reach in for types only.
 *
 * The server still validates. This only moves the first "no" to before the
 * request, where it can point at a field, instead of after a round trip.
 */
export function fieldProblem(key: ServerSettingKey, value: string): string | null {
  // `ServerSettingKey` and the CLI's `ConfigKey` are the same five strings;
  // the SPA spells them in its own type, so this is the one place they meet.
  return validateValue(key, value);
}

/**
 * Every field's problem, keyed — `{}` when the form is clean.
 *
 * @param drafts - only the fields the person actually edited
 */
export function formProblems<K extends ServerSettingKey>(
  drafts: Partial<Record<K, string>>,
): Partial<Record<K, string>> {
  const problems: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(drafts) as [K, string][]) {
    const problem = fieldProblem(key, value);
    if (problem !== null) problems[key] = problem;
  }
  return problems;
}
