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
