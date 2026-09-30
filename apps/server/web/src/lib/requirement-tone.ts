/**
 * The gold of requirement (operator rulings 2026-09-30, final shape): the
 * `*` beside a required input's label, and the caption that appears when the
 * caret LEAVES THE FIELD STILL EMPTY. Gold means "nothing typed yet".
 *
 * A HARD ERROR stays red (`text-destructive`): a value that validation
 * refuses (too long, mismatched, over the joined cap) or the server's
 * refusal of the submit is a DIFFERENT fact from an unfilled field -
 * "what you typed is wrong" - and reads as one everywhere. The split lives
 * in the schema: an issue tagged `gap: true` is a missing requirement,
 * anything else is a hard error; `fieldErrorToned` reads the tag.
 */
export const REQUIREMENT_CAPTION_CLASS = "text-amber-600 text-detail dark:text-amber-400";
