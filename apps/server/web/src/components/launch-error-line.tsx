import type { ReactNode } from "react";

/**
 * The launch refusal a dialog shows at form level.
 *
 * One component rather than three copies of the same `<p>`, for the reason that
 * settled it: the message must be announced, because the same refusal renders as an
 * announced `role="alert"` beside the Virtual display control when that checkbox is
 * on (`VirtualDisplayField`), and switching the box off must not move the sentence
 * from announced to silent. Declared at three call sites it was pinned at none;
 * declared here it is tested once, and a new launch surface cannot forget the role.
 */
export function LaunchErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive text-detail">
      {message}
    </p>
  );
}

/**
 * The launch form's content, with the refusal that content cannot host.
 *
 * The line has to sit OUTSIDE the agent/SSH branch, not inside the form: choosing
 * the SSH tab unmounts the Virtual display checkbox without clearing the error, and
 * a refusal nobody can read is the failure `splitLaunchError` exists to prevent.
 * Each dialog stated that placement itself, which meant a dialog could drop the
 * line and still render. Here the announcement travels with the content, so
 * rendering a launch form at all renders its refusal; the fragment adds no element,
 * which keeps every dialog's sticky-footer layout exactly where it was.
 */
export function LaunchRefusal({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <>
      {children}
      <LaunchErrorLine message={error} />
    </>
  );
}
