import { cn } from "@internal/node-admin";

/**
 * The tone of a backup field's validation sentence, decided the same way on
 * every backup card (ruling 2026-09-30): gold means "nothing typed yet", red
 * means "what you typed is wrong".
 *
 * The two cards once inferred the tone separately, one from the raw value and
 * one from its trimmed form, so a whitespace-only field was red on Create and
 * gold on Restore. A whitespace-only input is nothing typed, everywhere.
 * A problem supplied from outside the form (a server refusal, a failed
 * decrypt) is always the hard kind: something the person wrote was wrong.
 */
export function problemTone(value: string, suppliedProblem?: string | null): string {
  return cn("text-detail", suppliedProblem || value.trim() !== "" ? "text-destructive" : "text-warning");
}
