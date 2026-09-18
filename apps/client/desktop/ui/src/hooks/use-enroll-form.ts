/**
 * The enroll form's values, held OUTSIDE the DOM.
 *
 * The vanilla page needed this because it rebuilt the form whenever the step
 * changed; React needs it because the same three values are read at submit
 * time by an action that may then re-render everything under it. Either way the
 * typed value is the state and the input is a view of it.
 */
import { useState } from "react";
import type { EnrollFieldName } from "@/lib/copy";
import {
  EMPTY_ENROLL_VALUES,
  type EnrollErrors,
  type EnrollValues,
  NO_ENROLL_ERRORS,
  validateEnroll,
} from "@/lib/enroll-validation";

export interface EnrollForm {
  values: EnrollValues;
  errors: EnrollErrors;
  /** Type into one field, clearing its refusal — a refusal is re-earned at submit. */
  setField: (name: EnrollFieldName, value: string) => void;
  /**
   * Seed the server URL from the control plane this machine already answers to,
   * unless something is typed there. The common re-enroll is the same server
   * with a fresh key, and re-typing a URL is where a typo becomes a spent key.
   */
  seedServer: (url: string) => void;
  clearErrors: () => void;
  /**
   * Validate, rendering per-field refusals. Returns the arguments for
   * `node_enroll`, or null when something is wrong — in which case NO spawn
   * happens and no key can be spent.
   */
  validate: () => { server: string; key: string; name: string } | null;
  /**
   * Clear the spent credential, and ONLY that.
   *
   * The key is spent whatever happened, but a consumed credential has no
   * business sitting in a field where the next click could re-send it. The NAME
   * survives: since it became a required field rather than an optional one, a
   * retry with a freshly minted key means typing the whole form again, and the
   * name is neither a secret nor the thing that failed. (A taken name is the
   * common retry, and the fix there is a different name, which is what the
   * operator is about to type into this field anyway.)
   */
  clearSpentKey: () => void;
}

export function useEnrollForm(): EnrollForm {
  const [values, setValues] = useState<EnrollValues>(EMPTY_ENROLL_VALUES);
  const [errors, setErrors] = useState<EnrollErrors>(NO_ENROLL_ERRORS);

  return {
    values,
    errors,
    setField: (name, value) => {
      setValues((current) => ({ ...current, [name]: value }));
      setErrors((current) => (current[name] === "" ? current : { ...current, [name]: "" }));
    },
    seedServer: (url) => {
      setValues((current) => (current.server === "" ? { ...current, server: url } : current));
    },
    clearErrors: () => setErrors(NO_ENROLL_ERRORS),
    validate: () => {
      const result = validateEnroll(values);
      setErrors(result.errors);
      return result.invalid ? null : result.args;
    },
    clearSpentKey: () => {
      setValues((current) => ({ ...current, key: "" }));
      setErrors(NO_ENROLL_ERRORS);
    },
  };
}
