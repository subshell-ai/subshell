import { relativeElapsed } from "@internal/node-admin";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useId, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { CopyButton } from "@/components/copy-button";

/** A prompt table row; expanding its name reveals the full body without opening the editor. */
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
  /** Sharing or owner column: "Yes" or "No" on the owner tab, the author on the shared tab */
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
    <>
      <tr className="border-b align-middle last:border-0">
        <td className="h-8 @lg:w-1/3 w-full max-w-0 py-0 pr-4">
          <button
            type="button"
            title={description}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex max-w-full items-center gap-2 rounded-md text-left font-strong hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <span className="truncate">{description}</span>
          </button>
        </td>
        <td
          className="@3xl:table-cell hidden h-8 @sm:w-1/3 w-full max-w-0 truncate py-0 pr-4 text-muted-foreground"
          title={body}
        >
          {body.split("\n", 1)[0].trim() || "—"}
        </td>
        <td className="@lg:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground" title={badge}>
          {badge ?? "No"}
        </td>
        <td className="@2xl:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
          {relativeElapsed(updatedAt)}
        </td>
        <td className="h-8 w-px py-0 text-right">
          <div className="flex items-center justify-end gap-1">
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
                aria-label={`In ${stacks.count} ${stacks.count === 1 ? "stack" : "stacks"}`}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground text-sm hover:bg-accent/40 hover:text-foreground"
              >
                <Layers className="h-3.5 w-3.5 shrink-0" />
                <span className="@2xl:inline hidden whitespace-nowrap">
                  In {stacks.count} {stacks.count === 1 ? "stack" : "stacks"}
                </span>
              </button>
            )}
            <CopyButton text={body} label="prompt" />
            {items.length > 0 && <ActionsMenu label={description} items={items} />}
          </div>
        </td>
      </tr>
      {/* Unmounted while closed, the preset row's rule: hidden text should
          not sit in the DOM for find-in-page to trip over. */}
      {open && (
        <tr className="border-b last:border-0">
          <td colSpan={5} className="max-w-0">
            <pre
              id={bodyId}
              className="whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2 font-mono text-sm leading-relaxed"
            >
              {body}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
