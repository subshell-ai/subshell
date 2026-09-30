import { Badge, relativeElapsed } from "@internal/node-admin";
import { ChevronDown, ChevronRight, Layers, Pencil } from "lucide-react";
import { useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";
import { type StackItemRow, type StackRow, stackCountLabel, stackJoinedText } from "@/lib/prompt-stacks";

/**
 * One stack on the Prompts page (spec 2026-09-29): the page row's shape kept
 * exactly (label over detail, row click expands, menu beside copy), with two
 * stack facts added - the count line ("N prompts" / "Empty", the state the
 * delete cascade makes reachable) and the expansion: its members in launch
 * order, each with its own actions. Editing a member opens the PROMPT (the
 * stack references live rows, so the edit shows through right here); editing
 * an inline member opens the stack editor, where that text lives.
 *
 * `highlight` is the cross-link arrival: the prompt-page jump lands here,
 * and the ring is one-shot (the parent clears it, per the disclosure rule
 * that the page can point but never nag).
 */
export function StackPageRow({
  stack,
  badge,
  highlight = false,
  canEditStack = true,
  items,
  onEditMember,
  canEditMember,
}: {
  stack: StackRow;
  /** Right-side chip: "shared" on the owner tab, the author on the shared tab */
  badge?: string;
  highlight?: boolean;
  /** Whether the STACK can be edited here (the empty sentence names the
   *  remedy only when a control for it actually exists: shared stacks are
   *  read-only to their readers). */
  canEditStack?: boolean;
  /** The STACK's actions (Copy, Edit, Share, Remove...), built by the page */
  items: ActionItem[];
  /** A member's Edit: the page decides prompt-editor vs stack-editor. */
  onEditMember: (item: StackItemRow) => void;
  /** Whether this member's Edit may appear (own prompts only). */
  canEditMember: (item: StackItemRow) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const membersId = `stack-members-${stack.id}`;

  return (
    <div
      data-stack-id={stack.id}
      className={`rounded-lg border transition-colors hover:border-primary/60 ${highlight ? "ring-1 ring-primary" : ""}`}
    >
      <div className="flex items-center gap-2 px-2 py-3 pr-3">
        {/* The EXPANDER is the button (the prompt row's shape): the row also
            carries copy and menu buttons, and a button inside a button is
            the invalid HTML the linter refuses. */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={membersId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-accent/40"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="max-w-full truncate font-strong text-label">{stack.label}</span>
              {badge && (
                <Badge variant="secondary" className="shrink-0">
                  {badge}
                </Badge>
              )}
            </span>
            <span className="min-w-0 truncate text-detail text-muted-foreground">
              {stackCountLabel(stack.items)} · updated {relativeElapsed(stack.updatedAt)}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={stackJoinedText(stack)} label="stack" />
          {items.length > 0 && <ActionsMenu label={stack.label} items={items} />}
        </div>
      </div>
      {/* Unmounted while collapsed, the page rule: hidden text should not sit
          in the DOM for find-in-page to trip over. */}
      {open && (
        <ul id={membersId} className="space-y-1 border-t bg-muted/40 px-3 py-2" aria-label="Stack members">
          {stack.items.length === 0 && (
            <li className="text-detail text-muted-foreground">
              Nothing here: its prompts were removed or unshared.
              {canEditStack && " Edit the stack to add some."}
            </li>
          )}
          {stack.items.map((item, i) => (
            <li key={item.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="max-w-full truncate font-strong text-label">
                    {i + 1}. {item.description === "" ? "Untitled" : item.description}
                  </span>
                  {item.ownerName && (
                    <Badge variant="secondary" className="shrink-0">
                      {item.ownerName}
                    </Badge>
                  )}
                </span>
                <span className="min-w-0 truncate text-detail text-muted-foreground" title={item.body}>
                  {item.body.split("\n", 1)[0]}
                </span>
              </span>
              <CopyButton text={item.body} label={item.description === "" ? "prompt" : item.description} />
              {canEditMember(item) && (
                <ActionsMenu
                  label={item.description === "" ? "Untitled prompt" : item.description}
                  items={[{ label: "Edit", icon: Pencil, onSelect: () => onEditMember(item) }]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
