import { Button } from "@internal/node-admin";
import { ChevronDown, ChevronRight, ChevronUp, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The launch form's block stack (spec 2026-09-28): one line per picked
 * prompt, reorder up/down and remove. The prompt's FULL text is collapsed
 * by default (operator ruling 2026-09-29): the row is the launch form's
 * line item, and what the pane will receive is one click to read, the same
 * question the Prompts page row answers. Deliberately not drag-and-drop:
 * two buttons do the job accessibly and add no dependency.
 */
export function PromptStackList({
  blocks,
  onReorder,
  onRemove,
  labelledBy,
}: {
  blocks: PromptBlock[];
  onReorder: (localId: string, dir: -1 | 1) => void;
  onRemove: (localId: string) => void;
  /** Id of the element naming this list (the editor's "Prompts" label): a
   *  screen reader tabbing the rows hears the section they belong to (the
   *  round-8 nit: an unassociated Label is stray text to that cursor). */
  labelledBy?: string;
}) {
  return (
    <ul className="space-y-1" aria-labelledby={labelledBy}>
      {blocks.map((b, i) => (
        <PromptStackRow
          key={b.localId}
          block={b}
          position={i + 1}
          total={blocks.length}
          onReorder={onReorder}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

function PromptStackRow({
  block,
  position,
  total,
  onReorder,
  onRemove,
}: {
  block: PromptBlock;
  position: number;
  total: number;
  onReorder: (localId: string, dir: -1 | 1) => void;
  onRemove: (localId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // useId, not the description: two blocks may share one label, and a
  // description with a space would split the id into two IDREF tokens
  // (the page row's lesson).
  const bodyId = useId();
  return (
    // The label answers the same question the visible row does, so the
    // "Untitled" fallback belongs here too - a bare "" reads "Prompt ,".
    <li
      className="rounded-lg border"
      aria-label={`Prompt ${block.description === "" ? "Untitled" : block.description}, position ${position} of ${total}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {/* The EXPANDER is its own button (the page row's shape): the row
            also carries the reorder and remove buttons, and a button inside
            a button is the invalid HTML the linter refuses. */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left hover:bg-accent/40"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* "Untitled" is a display fallback, never data (the editor keeps
                an inline row's absent label absent). A stack block says what
                it is: one unit carrying N members (spec 2026-09-29). */}
            <span className="truncate font-strong text-label">
              {block.description === "" ? "Untitled" : block.description}
            </span>
            {/* Filter-and-join (the launch-defaults rule, round-6 nit): a
                body whose first line is blank drops its segment instead of
                dangling the separator. */}
            <span className="truncate text-detail text-muted-foreground">
              {[
                block.kind === "stack" && block.stackCount !== undefined
                  ? `stack · ${block.stackCount} ${block.stackCount === 1 ? "prompt" : "prompts"}`
                  : "",
                block.body.split("\n", 1)[0],
              ]
                .filter((p) => p.trim() !== "")
                .join(" · ")}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move prompt up"
            disabled={position === 1}
            onClick={() => onReorder(block.localId, -1)}
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move prompt down"
            disabled={position === total}
            onClick={() => onReorder(block.localId, 1)}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove prompt"
            className="text-destructive"
            onClick={() => onRemove(block.localId)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* Unmounted while collapsed, the page row's rule: hidden text should
          not sit in the DOM for find-in-page to trip over. */}
      {open && (
        <pre
          id={bodyId}
          className="whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2 font-mono text-sm leading-relaxed"
        >
          {block.body}
        </pre>
      )}
    </li>
  );
}
