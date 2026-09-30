import { Badge, relativeElapsed } from "@internal/node-admin";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useId, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";

/**
 * One prompt on the Prompts page (spec 2026-09-28): label over detail (the
 * design-system line-item shape: description in `label`, the body's first
 * line and the updated stamp in `detail`/muted). The ROW click expands, not
 * a side button — the whole row is the question "what is this prompt?"; the
 * menu and copy buttons stop propagation the way the menu already does.
 *
 * The stack count shows DIRECTLY (operator ruling 2026-09-29): the `stacks`
 * chip states how many stacks the prompt belongs to without opening a menu,
 * and pressing it toggles the caller's list of those stacks (which jump to
 * each). A prompt in no stack renders no chip.
 */
export function PromptPageRow({
  description,
  body,
  updatedAt,
  badge,
  stacks,
  items,
}: {
  description: string;
  body: string;
  updatedAt: string;
  /** Right-side chip: "shared" on the owner tab, the author on the shared tab */
  badge?: string;
  /** How many stacks this prompt is a member of, the toggle for that list, and
   *  the id of the disclosure panel the toggle opens (so aria-expanded points
   *  at something real, the way the row's body expander does). */
  stacks?: { count: number; open: boolean; onToggle: () => void; panelId: string };
  items: ActionItem[];
}) {
  const [open, setOpen] = useState(false);
  // useId, not the description: two rows may legally share one label (no
  // uniqueness on the column), and a description with a space would split
  // an id into two IDREF tokens and silently unlink aria-controls
  // (round-2 review fix).
  const bodyId = useId();

  return (
    <div className="rounded-lg border transition-colors hover:border-primary/60">
      <div className="flex items-center gap-2 px-2 py-3 pr-3">
        {/* The EXPANDER is the button (label + preview), not the row: the row
            also carries copy and menu buttons, and a button inside a button
            is the invalid HTML the linter refuses. Clicking the name is the
            question "what is this prompt?", which is what reads as the row's
            body anyway. */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-accent/40"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="max-w-full truncate font-strong text-label">{description}</span>
              {badge && (
                <Badge variant="secondary" className="shrink-0">
                  {badge}
                </Badge>
              )}
            </span>
            {/* Filter-and-join, the third site of the round-6 rule: a body
                starting with a newline drops its preview segment instead of
                dangling " · updated". */}
            <span className="min-w-0 truncate text-detail text-muted-foreground" title={body}>
              {[body.split("\n", 1)[0], `updated ${relativeElapsed(updatedAt)}`]
                .filter((p) => p.trim() !== "")
                .join(" · ")}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {stacks && stacks.count > 0 && (
            // The count is the row's own answer (not a menu hunt); pressing it
            // opens the caller's list of stacks. In the controls row (a sibling
            // of the expander), it never nests a button in a button.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                stacks.onToggle();
              }}
              aria-expanded={stacks.open}
              aria-controls={stacks.panelId}
              title="View the stacks this prompt is in"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-detail text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <Layers className="h-3.5 w-3.5 shrink-0" />
              In {stacks.count} {stacks.count === 1 ? "stack" : "stacks"}
            </button>
          )}
          <CopyButton text={body} label="prompt" />
          {items.length > 0 && <ActionsMenu label={description} items={items} />}
        </div>
      </div>
      {/* Unmounted while closed, the preset row's rule: hidden text should
          not sit in the DOM for find-in-page to trip over. */}
      {open && (
        <pre
          id={bodyId}
          className="whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2 font-mono text-sm leading-relaxed"
        >
          {body}
        </pre>
      )}
    </div>
  );
}
