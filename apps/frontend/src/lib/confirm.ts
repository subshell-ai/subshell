/**
 * Promise-based confirmation prompts, the styled replacement for
 * `window.confirm`.
 *
 * The dialog itself lives in `ConfirmProvider` (components/ui/confirm-dialog),
 * mounted once at the app root; this module is the imperative handle to it.
 * Going through a module-level handler rather than a hook means event
 * handlers, mutation helpers, and non-component code (the bulk bar, the dock)
 * all share one mechanism without threading `useConfirm` through props.
 */

/** Options describing a confirmation prompt. */
export interface ConfirmOptions {
  /** Headline question, e.g. `Delete session "web"?` */
  title: string;
  /** Supporting detail under the headline */
  description?: string;
  /** Label of the affirmative button (default "Confirm") */
  confirmLabel?: string;
  /** Renders the affirmative button in the destructive style */
  danger?: boolean;
}

/** Registers the provider's implementation; `null` unregisters it. */
type ConfirmHandler = (options: ConfirmOptions) => Promise<boolean>;

let handler: ConfirmHandler | null = null;

/**
 * Wires `confirmAction` to a live dialog. Called by `ConfirmProvider` on
 * mount; tests may install a stub.
 * @internal
 * @param next - The handler to install, or null to remove the current one
 * @returns The previously registered handler, for the new owner to restore
 *          on unmount (so a remount never unregisters its own replacement)
 */
export function setConfirmHandler(next: ConfirmHandler | null): ConfirmHandler | null {
  const previous = handler;
  handler = next;
  return previous;
}

/**
 * Opens a styled confirm dialog and waits for the user's answer.
 *
 * Resolving `false` on a missing provider aborts the action rather than
 * silently performing it — the same outcome as a dismissed prompt.
 * @param options - The prompt's wording and button labels
 * @returns True when the user explicitly confirms
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (!handler) {
    console.warn("confirmAction called with no ConfirmProvider mounted; treating as cancelled");
    return Promise.resolve(false);
  }
  return handler(options);
}
