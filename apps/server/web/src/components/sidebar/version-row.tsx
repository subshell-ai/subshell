import { ArrowUpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The sidebar footer's version line: what this is, and one amber dot when
 * something newer exists (operator's call, 2026-09-18).
 *
 * **One shape for two different facts**, which is the whole reason it is a
 * component rather than two hand-rolled rows. Inside Subshell Server the line
 * names the APP's own build, read over IPC from a check that runs once a day.
 * In a browser — and in Subshell Client's window, which is a browser for this
 * purpose — it names the SERVER this page is talking to, which
 * `GET /api/settings/public` hands every signed-in caller. Those are genuinely
 * different versions, and the route's own comment is why the second one is
 * readable at all: "a version nobody can see without an admin session is a
 * version nobody quotes in a bug report."
 *
 * **The marker is a status light, so it has no off switch.** The row it
 * replaced was a two-line block with an [Update] button and a × that wrote the
 * dismissed version to `sessionStorage`; pressing the row does what the button
 * did, and with nothing loud left there is nothing to silence. A marker a
 * person can turn off is a status light that lies.
 *
 * **It is `ArrowUpCircle`, not a dot, and the version is not in the line**
 * (operator's report, 2026-09-19). The line read
 * `Subshell Server 0.11.1 — v0.12.0 available` and the sidebar has nowhere
 * near that much room, so it truncated to `Subshell Server 0.11.1 — v0…`,
 * spending the width on an ellipsis. The newer version now lives in the
 * tooltip and the accessible name, where there IS room; the glyph carries
 * "newer exists" on screen. `ArrowUpCircle` is the same icon the sidebar's
 * Updates nav item uses — and pressing this row goes exactly there, so the
 * two agree by construction rather than by coincidence.
 *
 * `text-warning`, not a hex: the same amber the trust indicators use, so
 * "something wants your attention" reads the same everywhere, and
 * `lint:design` refuses anything else.
 *
 * A row with no `onActivate` renders inert, which is the right answer for a
 * viewer who cannot act on what it says — a member in a browser can read the
 * server's version and can do nothing about it, and a control that refuses is
 * worse than a line that never offered.
 */
export function VersionRow({
  label,
  notice,
  onActivate,
  actionLabel,
  collapsed,
}: {
  /** The full line, e.g. `Subshell Server 0.10.1` — already assembled. */
  label: string;
  /**
   * The newer version, when one is known. Present means the icon renders and
   * the TOOLTIP says what it is — never the visible line, which has no room;
   * null renders the line alone, which is NOT a claim of being up to date — it
   * covers "nobody has checked" too.
   */
  notice: string | null;
  /** What pressing it does. Absent renders an inert line. */
  onActivate?: () => void;
  /**
   * What the press DOES, for the accessible name — "Check for updates",
   * "Open updates". Required in practice wherever `onActivate` is, because
   * the visible text is a version and a version does not say it is a button:
   * a screen reader would otherwise announce "Subshell Server 0.10.1, button"
   * and leave the person to guess. Ignored on an inert row, which has no act
   * to describe.
   */
  actionLabel?: string;
  /** The 56px rail: there is no room for text, so only the icon survives. */
  collapsed: boolean;
}) {
  // The VISIBLE line is the label alone. `title` is the longer sentence, and it
  // reaches the reader through the tooltip and the accessible name — the two
  // places that are not 200px wide.
  const title = notice === null ? label : `${label} — v${notice} available`;
  const behind = notice !== null;

  // Collapsed with nothing to say is nothing at all: a version the rail cannot
  // print is not worth a row, and an icon with no news is decoration.
  if (collapsed && !behind) return null;

  const shared = cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-detail text-muted-foreground",
    collapsed && "justify-center px-0",
  );

  const body = (
    <>
      {/* The slot is ALWAYS rendered and is a FIXED `size-3.5`, so the text
          keeps one indent whether or not there is news, and lines up with
          `DesktopServerPill` directly above it (operator's report, 2026-09-18 —
          with the marker conditionally absent, a row with no news started flush
          left and the two footer lines did not agree). That pill centres its
          own `size-2` status dot in a slot of this same width, which is what
          lets a 14px icon here and an 8px dot there still agree on where the
          text begins.

          `aria-hidden`: the icon renders the notice, and the accessible name
          already says the version in words — announcing both reads one fact
          twice. `invisible` rather than a transparent colour, so it is out of
          the accessibility tree as well as out of sight. */}
      <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center", !behind && "invisible")}>
        <ArrowUpCircle className="size-3.5 text-warning" />
      </span>
      {/* Kept in the DOM when collapsed rather than dropped: it is the
          accessible name of the whole row, button or not. The VISIBLE text is
          `label`; the newer version rides in `title`/`aria-label` above. */}
      <span className={cn("truncate", collapsed && "sr-only")}>{label}</span>
    </>
  );

  if (onActivate === undefined) {
    return (
      <div className={shared} title={title}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onActivate}
      title={title}
      aria-label={actionLabel === undefined ? title : `${title}. ${actionLabel}.`}
      className={cn(shared, "cursor-pointer transition-colors hover:bg-accent/50 hover:text-accent-foreground")}
    >
      {body}
    </button>
  );
}
