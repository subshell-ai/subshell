import { cn } from "@internal/node-admin";

/**
 * A working directory clipped from the FRONT, so a long path still names its
 * leaf (`…/projects/hmn-vm`): what tells two panes apart sits at the end of a
 * path, and a plain `truncate` spends the visible width on the shared
 * prefix instead.
 *
 * The mechanism is CSS, not a character budget: `direction: rtl` moves the
 * line's overflow (and the ellipsis) to the left edge, `text-align: left`
 * keeps SHORT paths flush left as usual, and the `<bdi>` isolate makes the
 * path itself resolve to LTR from its own content, so the glyphs never
 * reorder. One honest limit inside that isolate: `bdi` picks a direction
 * from the first STRONG character, so a path whose name itself opens in an
 * RTL script lays out RTL and the clip eats its end instead. A leading slash
 * is neutral and does not count as an opening; paths whose first segment
 * begins with a Latin letter or a Windows drive letter are unaffected,
 * whatever the leaf's script. Because
 * the browser does the clipping, one component fits the rail, the card, the
 * header, and the table column without a width guess per surface.
 *
 * Callers add the display and colour classes (`block`, `text-detail`, …)
 * through `className`; the truncation itself is not overridable. The full
 * path stays in the DOM, so a tooltip or `title` on the row still reads it
 * whole.
 */
export function PathTail({ path, className, title }: { path: string; className?: string; title?: string }) {
  return (
    <span dir="rtl" title={title} className={cn("min-w-0 truncate text-left", className)}>
      <bdi>{path}</bdi>
    </span>
  );
}
