import { Button } from "@internal/node-admin";
import { Plus } from "lucide-react";
import { type JSX, useState } from "react";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
import { movePromptBlock, type PromptBlock, removePromptBlock } from "@/lib/prompt-stack";

/**
 * The "Add prompts" section, shared verbatim by the preset editors and the
 * launch form (operator ruling 2026-09-30: the launch form's checkbox went
 * the way of the preset's - a box that HIDES the add button makes the
 * feature look finished when it is empty, and the two surfaces should read
 * as one thing). Divider, title, sentence, the stack once non-empty, and an
 * always-visible Add button that opens the picker INLINE (the dialog-on-
 * dialog stack read as weird; this is the same body the inject action puts
 * on a Dialog). A pick lands the block and collapses back to the button;
 * the half-typed CUSTOM text outlives the collapse on purpose (the picker's
 * sessionStorage draft, durable until submitted).
 *
 * WHAT the blocks mean differs by surface and lives with the caller: here
 * they are just the list the person edits.
 */
export function PromptStackSection({
  blocks,
  onBlocksChange,
  draftScope,
  addButtonId,
}: {
  blocks: PromptBlock[];
  onBlocksChange: (blocks: PromptBlock[]) => void;
  /** Per-person draft isolation (the preset editors pass one; the launch
   *  form's single draft needs none). */
  draftScope?: string;
  /** Element id on the Add button, for callers with e2e-pinned ids. */
  addButtonId?: string;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="font-strong text-sm leading-none">Add prompts</p>
      <p className="text-detail text-muted-foreground">Prompts to inject on subshell creation.</p>
      {blocks.length > 0 && (
        <PromptStackList
          blocks={blocks}
          onReorder={(localId, dir) => onBlocksChange(movePromptBlock(blocks, localId, dir))}
          onRemove={(localId) => onBlocksChange(removePromptBlock(blocks, localId))}
        />
      )}
      {pickerOpen ? (
        <div className="rounded-lg border p-3">
          <PromptPickerBody
            surface="inline"
            mode="multi"
            draftScope={draftScope}
            onPick={(block) => {
              onBlocksChange([...blocks, block]);
              setPickerOpen(false);
            }}
            onExit={() => setPickerOpen(false)}
          />
        </div>
      ) : (
        <Button type="button" id={addButtonId} variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
          <Plus /> Add prompt
        </Button>
      )}
    </div>
  );
}
