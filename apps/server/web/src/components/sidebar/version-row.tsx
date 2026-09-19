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
 * **The dot is a status light, so it has no off switch.** The row it replaced
 * was a two-line block with an [Update] button and a × that wrote the
 * dismissed version to `sessionStorage`; pressing the row does what the button
 * did, and with nothing loud left there is nothing to silence. A dot a person
 * can turn off is a status light that lies.
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
   * The newer version, when one is known. Present means the dot renders and
   * the title says what it is; null renders the line alone, which is NOT a
   * claim of being up to date — it covers "nobody has checked" too.
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
  /** The 56px rail: there is no room for text, so only the dot survives. */
  collapsed: boolean;
}) {
  const title = notice === null ? label : `${label} — v${notice} available`;
  const dot = notice !== null;

  // Collapsed with nothing to say is nothing at all: a version the rail cannot
  // print is not worth a row, and a dot with no news is decoration.
  if (collapsed && !dot) return null;

  const shared = cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-detail text-muted-foreground",
    collapsed && "justify-center px-0",
  );

  const body = (
    <>
      {/* ALWAYS rendered, invisible when there is nothing to say, so the text
          keeps the dot's indent either way and lines up with `DesktopServerPill`
          directly above it (operator's report, 2026-09-18 — with the dot
          conditionally absent, a row with no news started flush left and the
          two footer lines did not agree). Same `size-2` as that row's own
          `Circle`, for the same reason.

          `aria-hidden`: the dot renders the notice, and the accessible name
          already says the version in words — announcing both reads one fact
          twice. `invisible` rather than a transparent colour, so it is out of
          the accessibility tree as well as out of sight. */}
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot ? "bg-warning" : "invisible")} />
      {/* Kept in the DOM when collapsed rather than dropped: it is the
          accessible name of the whole row, button or not. */}
      <span className={cn("truncate", collapsed && "sr-only")}>{title}</span>
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
