import { Badge, Button, relativeElapsed } from "@internal/node-admin";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";

/**
 * One prompt on the Prompts page (spec 2026-09-28): label over detail (the
 * design-system line-item shape: description in `label`, the body's first
 * line and the updated stamp in `detail`/muted). The ROW click expands, not
 * a side button — the whole row is the question "what is this prompt?"; the
 * menu and copy buttons stop propagation the way the menu already does.
 */
export function PromptPageRow({
  description,
  body,
  updatedAt,
  badge,
  items,
}: {
  description: string;
  body: string;
  updatedAt: string;
  /** Right-side chip: "shared" on the owner tab, the author on the shared tab */
  badge?: string;
  items: ActionItem[];
}) {
  const [open, setOpen] = useState(false);
  // useId, not the description: two rows may legally share one label (no
  // uniqueness on the column), and a description with a space would split
  // an id into two IDREF tokens and silently unlink aria-controls
  // (round-2 review fix).
  const bodyId = useId();
  const [copied, setCopied] = useState(false);
  // One live timer, cleared on unmount and by a second press (review fix):
  // an unclean 1500 ms reset outlives a row that closed, and a plain-http
  // clipboard rejects on some hosts, where silence means no checkmark, not a
  // console error.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

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
            <span className="min-w-0 truncate text-detail text-muted-foreground" title={body}>
              {body.split("\n", 1)[0]} · updated {relativeElapsed(updatedAt)}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={(e) => void copy(e)} aria-label="Copy prompt">
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <ActionsMenu label={description} items={items} />
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
