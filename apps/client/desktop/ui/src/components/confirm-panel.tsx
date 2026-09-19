/**
 * Anything the user must acknowledge before it happens: spending a setup key,
 * replacing the installed node CLI, killing live panes.
 *
 * In the page rather than in a native dialog on purpose: these messages are
 * several sentences of consequence — what a spent setup key costs, which
 * subshells a restart kills — and a modal that has to be dismissed to re-read
 * the form behind it is the wrong shape for that. The app grants no dialog
 * surface at all now (`capabilities/node.json` held `dialog:allow-open` and
 * `dialog:allow-message` while the node-binary picker existed, and no `ask`
 * even then), so there is nothing native to fall back to here.
 *
 * It is also why nothing here is portalled or anchored. The bundle's CSP has no
 * `'unsafe-inline'` in `style-src`, which blocks inline style ATTRIBUTES as
 * well as `<style>` elements — so a popover primitive that positions itself
 * with a `style` prop would render, unstyled, in the wrong place.
 */
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingConfirmation } from "@/lib/actions";

export function ConfirmPanel(props: {
  pending: PendingConfirmation;
  busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { pending, busy, onAccept, onCancel } = props;
  return (
    // A labelled region, so the panel is one addressable thing: its accept
    // button often carries the same words as the button that raised it
    // ("Enroll this machine"), and both a screen reader and a test need to be
    // able to tell the two apart.
    <section aria-label={pending.title} className="mt-3.5 rounded-lg border border-warning bg-background px-3.5 py-3">
      <p className="flex items-center gap-2 font-strong text-warning text-detail">
        <TriangleAlert aria-hidden className="shrink-0" />
        {pending.title}
      </p>
      {pending.messages.map((message) => (
        // `whitespace-pre-wrap`: a message may be the CLI's own refusal text
        // quoted into this panel, and it keeps the shape it was printed in.
        <p key={message} className="mt-2 whitespace-pre-wrap text-muted-foreground text-detail leading-relaxed">
          {message}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" onClick={onAccept} disabled={busy}>
          {pending.acceptLabel}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
