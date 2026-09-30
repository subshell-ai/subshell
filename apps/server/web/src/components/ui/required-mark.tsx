/**
 * The gold `*` beside a REQUIRED input's label (ruling 2026-09-30): the
 * standing answer to "must I fill this?", shown before any blur, in the same
 * gold the blur caption wears. `aria-hidden` because it is a sight-rule for
 * the eye - the form's real state is the disabled submit and the caption.
 *
 * The glyph is GENERATED (`after:content`), not a text child: a literal "*"
 * would ride in the label's text content, and every query, test and
 * screen-reader name that says "Name" would have to say "Name *".
 */
export function RequiredMark() {
  return <span aria-hidden="true" className="ml-1 text-amber-600 after:content-['*'] dark:text-amber-400" />;
}
