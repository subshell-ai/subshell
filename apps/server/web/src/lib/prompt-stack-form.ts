import { z } from "zod";
import type { PromptBlock } from "./prompt-stack";
import type { StackItemRow } from "./prompt-stacks";

/**
 * The pure half of the stack editor (spec 2026-09-29): the draft shape, the
 * two conversions between server items and editor blocks (the launch form's
 * blocks are deliberately REUSED as the editor's rows: same up/down/remove
 * list, same shapes), and the one validation rule the dialog gates Save on,
 * the form-substrate contract from spec 2026-09-29.
 */

/** What goes on the wire: a reference, or the stack's own inline text. */
export type StackMemberWire = { promptId: string } | { body: string; description?: string };

/** The dialog's draft; the POST body and the PUT patch alike. */
export interface PromptStackDraft {
  label: string;
  items: StackMemberWire[];
  shared: boolean;
}

/**
 * The cap the SERVER enforces (the joined text rides the one launch field):
 * stated here so the editor says it inline, under the control, at save time.
 */
export const STACK_JOINED_CAP = 20000;
export const STACK_MAX_ITEMS = 50;

/**
 * Editor blocks to wire members, in stack order. Custom text is stored
 * inline; an unlabeled inline row stays unlabeled ("" rides as absent, the
 * "Untitled" wording is the LIST's display fallback, never data).
 */
export function stackMembersFromBlocks(blocks: readonly PromptBlock[]): StackMemberWire[] {
  return blocks.map((b) =>
    b.kind === "saved" && b.promptId
      ? { promptId: b.promptId }
      : b.description === ""
        ? { body: b.body }
        : { body: b.body, description: b.description },
  );
}

/**
 * Server members to editor rows, seeded into the dialog. A reference is a
 * "saved" block (the prompt row's live text shows in the list); the stack's
 * own inline text is a "custom" block (no library row behind it), its label
 * stored exactly as the server holds it.
 */
export function stackBlocksFromItems(items: readonly StackItemRow[]): PromptBlock[] {
  return items.map((i) =>
    i.promptId
      ? { localId: i.id, kind: "saved" as const, promptId: i.promptId, description: i.description, body: i.body }
      : { localId: i.id, kind: "custom" as const, description: i.description, body: i.body },
  );
}

/** The joined text the editor would save, the same join the server caps. */
export function joinedMemberText(blocks: readonly PromptBlock[]): string {
  return blocks.map((b) => b.body).join("\n\n");
}

/** The editor's block rows are built by code, not typed by a person: the
 *  zod side trusts the shape (a structural check, not a field-by-field
 *  re-validation of what only the library and the server round-tripped). */
const blockShape = z.custom<PromptBlock>(
  (v) => typeof v === "object" && v !== null && "localId" in v && "kind" in v && "body" in v,
);

/**
 * The ONE validity rule (form-substrate pattern), so the gated Save button
 * and the submit guard cannot drift: label required non-blank and within the
 * server's 120-char cap, at most 50 members, and the joined text within the
 * 20000 wire cap. A stack born needs one member; an EDIT may empty it (that
 * save is a real answer, the empty-stack lifecycle), so the floor is a mode,
 * not a second schema. The label cap lives here (not only the field's
 * maxLength) so a paste is refused inline, never on the server round-trip.
 */
export function makePromptStackSchema(minItems: number) {
  return z
    .object({
      label: z.string().max(120, "A stack label is at most 120 characters"),
      blocks: z.array(blockShape).max(STACK_MAX_ITEMS),
      shared: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (values.label.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["label"], message: "A stack needs a short label" });
      }
      if (values.blocks.length < minItems) {
        ctx.addIssue({ code: "custom", path: ["blocks"], message: "A stack needs at least one prompt" });
      }
      const joined = joinedMemberText(values.blocks as PromptBlock[]);
      if (joined.length > STACK_JOINED_CAP) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks"],
          message: `The prompts joined are ${joined.length} characters; the pane takes one string capped at ${STACK_JOINED_CAP}`,
        });
      }
    });
}
