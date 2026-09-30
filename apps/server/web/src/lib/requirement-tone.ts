/**
 * The gold of requirement (operator ruling 2026-09-30): the `*` beside a
 * required input's label, and the sentence that appears WHEN THE FIELD IS
 * BLURRED still empty - or holding what validation refuses. Required and
 * failed captions wear the SAME tone: both answer "why is Create dead", and
 * one more color distinction bought nothing the caret did not already say.
 * A dialog-level server refusal (the submit itself failed) is a different
 * fact and stays `text-destructive`, rendered on the dialog that failed.
 */
export const REQUIREMENT_CAPTION_CLASS = "text-amber-600 text-detail dark:text-amber-400";
