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
 * What changed since (operator ruling 2026-09-22: "use a dialog when it comes
 * to user confirmation"): this content is every confirmation the app raises,
 * and it now renders inside the app's own modal — one `Dialog`, not a pane
 * grown inside the section the act belongs to. The sentence above about
 * modals still argues correctly about NATIVE ones and their dismissal-first
 * shape; the answer is that the sentences moved INTO the dialog, which is
 * what makes the ruling sound. Escape and a backdrop press are the cancel.
 * The class-positioned overlay is also why the CSP note below still holds:
 * `style-src` blocks style ATTRIBUTES, so this dialog (like the plane row's
 * action menu) positions itself with classes only, never a measuring popper.
 */
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { PendingConfirmation } from "@/lib/actions";

export function ConfirmPanel(props: {
  pending: PendingConfirmation;
  busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { pending, busy, onAccept, onCancel } = props;
  return (
    // A labelled dialog, so the panel is one addressable thing: its accept
    // button often carries the same words as the button that raised it
    // ("Enroll this machine"), and both a screen reader and a test need to be
    // able to tell the two apart. The dismissal routes to onCancel: refusing
    // by Escape is refusing.
    <Dialog
      title={pending.title}
      onClose={onCancel}
      heading={
        <p className="text-warning flex items-center gap-2 font-strong text-label">
          <TriangleAlert aria-hidden className="shrink-0" />
          {pending.title}
        </p>
      }
    >
      {pending.messages.map((message) => (
        // `whitespace-pre-wrap`: a message may be the CLI's own refusal text
        // quoted into this panel, and it keeps the shape it was printed in.
        <p key={message} className="mt-2 whitespace-pre-wrap text-muted-foreground text-detail leading-relaxed">
          {message}
        </p>
      ))}
      {/* The bar's grammar, in the card: ghost left, the weight right. */}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={onAccept} disabled={busy}>
          {pending.acceptLabel}
        </Button>
      </div>
    </Dialog>
  );
}
