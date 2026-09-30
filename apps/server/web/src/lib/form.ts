import type { StandardSchemaV1 } from "@tanstack/react-form";
import { type AnyFormApi, type ReactFormExtendedApi, useForm, useStore } from "@tanstack/react-form";

/**
 * The shared form substrate (spec 2026-09-29). Every form with required input
 * runs through `makeForm`, so its submit button and its validation cannot
 * drift apart: validity comes from ONE structural validator over the whole
 * draft, and `useSubmitDisabled` is the only expression a swept button passes
 * to `disabled`. Handler early-returns stay anyway — disable explains
 * readiness, the guard guarantees it (Enter-key implicit submission, render
 * races around mutations).
 */

/** Field → the one sentence that explains it. The shape `formProblems`
 *  already returns, so server-shadowing validators plug in unwrapped. */
export type FieldProblems = Record<string, string>;

export type StructuralValidator<TValues> = StandardSchemaV1<TValues> | ((values: TValues) => FieldProblems);

/** The form handle callers hold: values stay typed per field; the
 *  validator-error generics are erased on purpose — errors are read as
 *  unknown lists through `fieldError`, never by their concrete validator
 *  shape. (TanStack's options inference refuses an internal union of the two
 *  validator kinds, so the branches below stay concrete and unify here.) */
export type SubshellForm<TValues extends Record<string, unknown>> = ReactFormExtendedApi<
  TValues,
  any, // erased validator-error generics, see above
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

export function makeForm<TValues extends Record<string, unknown>>(opts: {
  defaultValues: TValues;
  /** A zod schema (Standard Schema, auto-detected by TanStack Form), or the
   *  existing field-problem function when its rules shadow the server's. */
  validator: StructuralValidator<TValues>;
  onSubmit: (values: TValues) => void | Promise<void>;
}): SubshellForm<TValues> {
  const onSubmit = ({ value }: { value: TValues }) => opts.onSubmit(value);
  // onMount matters as much as onChange: without it a pristine form has run
  // no validator at all, reports itself valid, and the gated button would
  // start ENABLED until the first keystroke (measured, 1.33.5).
  if (typeof opts.validator === "function") {
    const problems = opts.validator;
    const validator = ({ value }: { value: TValues }) => {
      const found = problems(value);
      return Object.keys(found).length === 0 ? undefined : { fields: found };
    };
    // biome-ignore lint/correctness/useHookAtTopLevel: the branch is decided by the validator KIND, a module-constant property of each caller — no call site switches branch between renders
    return useForm({
      defaultValues: opts.defaultValues,
      validators: { onMount: validator, onChange: validator, onSubmit: validator },
      onSubmit,
    }) as unknown as SubshellForm<TValues>;
  }
  const schema = opts.validator;
  // biome-ignore lint/correctness/useHookAtTopLevel: same as above — branch stability holds per call site
  return useForm({
    defaultValues: opts.defaultValues,
    validators: { onMount: schema, onChange: schema, onSubmit: schema },
    onSubmit,
  }) as unknown as SubshellForm<TValues>;
}

/** The boolean for a swept button's `disabled`: busy, mid-submit, or the
 *  single validator says the draft is not submittable. */
export function useSubmitDisabled(form: AnyFormApi, busy = false): boolean {
  return useStore(form.store, (state) => !state.isValid || state.isSubmitting) || busy;
}

/** The field's one sentence, or null. Errors carry the source object shape
 *  once Standard Schema produced them, bare strings otherwise. */
/**
 * `fieldError` plus the TONE: an issue tagged `gap: true` names a MISSING
 * REQUIREMENT (render `REQUIREMENT_CAPTION_CLASS` - gold), anything else is
 * a HARD ERROR (render `text-destructive` - red). Only slots that can carry
 * both kinds need this; a slot whose schema speaks only requirements colors
 * its className outright.
 */
export function fieldErrorToned(errors: readonly unknown[]): { text: string; gap: boolean } | null {
  for (const error of errors) {
    if (typeof error === "string" && error !== "") return { text: error, gap: false };
    if (typeof error === "object" && error !== null && "message" in error) {
      const tagged = error as { message?: unknown; gap?: unknown };
      if (typeof tagged.message === "string" && tagged.message !== "") {
        return { text: tagged.message, gap: tagged.gap === true };
      }
    }
  }
  return null;
}

export function fieldError(errors: readonly unknown[]): string | null {
  for (const error of errors) {
    if (typeof error === "string" && error !== "") return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  return null;
}
