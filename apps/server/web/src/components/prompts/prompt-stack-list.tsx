import { Button } from "@internal/node-admin";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The launch form's block stack (spec 2026-09-28): one line per picked
 * prompt, reorder up/down and remove. Deliberately not drag-and-drop: two
 * buttons do the job accessibly and add no dependency.
 */
export function PromptStackList({
  blocks,
  onReorder,
  onRemove,
}: {
  blocks: PromptBlock[];
  onReorder: (localId: string, dir: -1 | 1) => void;
  onRemove: (localId: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {blocks.map((b, i) => (
        <li
          key={b.localId}
          className="flex items-center gap-2 rounded-lg border px-3 py-2"
          aria-label={`Prompt ${b.description}, position ${i + 1} of ${blocks.length}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-strong text-label">{b.description}</span>
            <span className="truncate text-detail text-muted-foreground">{b.body.split("\n", 1)[0]}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move prompt up"
              disabled={i === 0}
              onClick={() => onReorder(b.localId, -1)}
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move prompt down"
              disabled={i === blocks.length - 1}
              onClick={() => onReorder(b.localId, 1)}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove prompt"
              className="text-destructive"
              onClick={() => onRemove(b.localId)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
