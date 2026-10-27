import { isDisplayLaunchRefusal } from "@/lib/create-subshell-error";

/**
 * Which line a launch refusal is shown on.
 *
 * A refusal about the virtual display belongs beside the **Virtual display**
 * checkbox that caused it, because that is the control the person would change.
 * The checkbox is mounted only by the agent branch of the launch form, and the
 * mode and kind toggles can unmount it while the error stays set, so the rule
 * needs both halves: the field owns it while it exists, and the form line takes
 * it back when it does not. A refusal nobody can read is worse than one shown
 * in two places, and this is what "exactly one place" has to mean.
 */
/**
 * Whether the **Virtual display** field is the one that hosts a display refusal:
 * the agent branch is mounted AND the box is switched on.
 *
 * The three dialogs used to write this condition inline, which meant the whole
 * rule lived in a line no test reached: drop the box term and a refusal under an
 * unchecked checkbox lands on a field that hides it, with the form line also
 * empty, so the message disappears with every suite green. One function, one
 * unit test, and the field's own `checked` guard as a second layer.
 */
export function displayFieldOwnsRefusal({
  mounted,
  virtualDisplay,
}: {
  mounted: boolean;
  virtualDisplay: boolean | undefined;
}): boolean {
  return mounted && virtualDisplay === true;
}

export function splitLaunchError(
  error: string | null,
  showsDisplayField: boolean,
): { field: string | null; form: string | null } {
  if (error === null) return { field: null, form: null };
  if (showsDisplayField && isDisplayLaunchRefusal(error)) return { field: error, form: null };
  return { field: null, form: error };
}
