import { cn, relativeElapsed } from "@internal/node-admin";
import { ChevronDown, ChevronRight, Layers, Pencil } from "lucide-react";
import { useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";
import { type StackItemRow, type StackRow, stackCountLabel, stackJoinedText } from "@/lib/prompt-stacks";

/** A stack table row; expansion keeps its members in launch order with their own actions. */
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
  /** Sharing or owner column: "Yes" or "No" on the owner tab, the author on the shared tab */
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
    <>
      <tr
        data-stack-id={stack.id}
        className={cn("border-b align-middle last:border-0", highlight && "ring-1 ring-primary")}
      >
        <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
          <button
            type="button"
            title={stack.label}
            aria-expanded={open}
            aria-controls={membersId}
            className="flex max-w-full items-center gap-2 rounded-md text-left font-strong hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{stack.label}</span>
          </button>
        </td>
        <td className="@sm:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {stackCountLabel(stack.items)}
        </td>
        <td className="@lg:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground" title={badge}>
          {badge ?? "No"}
        </td>
        <td className="@2xl:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {relativeElapsed(stack.updatedAt)}
        </td>
        <td className="h-8 w-px py-0 text-right">
          <div className="flex items-center justify-end gap-1">
            <CopyButton text={stackJoinedText(stack)} label="stack" />
            {items.length > 0 && <ActionsMenu label={stack.label} items={items} />}
          </div>
        </td>
      </tr>
      {/* Unmounted while collapsed, the page rule: hidden text should not sit
          in the DOM for find-in-page to trip over. */}
      {open && (
        <tr className="border-b last:border-0">
          <td colSpan={5} className="max-w-0">
            <ul id={membersId} className="space-y-1 border-t bg-muted/40 px-3 py-2" aria-label="Stack members">
              {stack.items.length === 0 && (
                <li className="text-muted-foreground text-sm">
                  Nothing here: its prompts were removed or unshared.
                  {canEditStack && " Edit the stack to add some."}
                </li>
              )}
              {stack.items.map((item, i) => (
                <li key={item.id} className="flex items-center gap-2 rounded-md px-1 py-1">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="max-w-full truncate font-strong text-sm">
                        {i + 1}. {item.description === "" ? "Untitled" : item.description}
                      </span>
                      {item.ownerName && (
                        <span className="min-w-0 truncate text-muted-foreground text-sm" title={item.ownerName}>
                          {item.ownerName}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground text-sm" title={item.body}>
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
          </td>
        </tr>
      )}
    </>
  );
}
