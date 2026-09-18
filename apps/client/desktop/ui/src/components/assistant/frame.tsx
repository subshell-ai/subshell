/**
 * The assistant frame (spec 2026-09-11 § 3, spec 2026-09-12 § 6.4).
 *
 * One visual specification, three implementations — the server app's native
 * page, the SPA's `/setup`, and this. They share no code, so the spec is what
 * keeps them one product and the geometry below is written out rather than
 * inherited: 1024×720 window, a 560px column centred in the region, a 72px
 * bottom bar with a hairline top, primary right and ghost left.
 *
 * There is no About line under the bar (operator's call, 2026-09-12): a
 * colophon under every screen read as part of the question being asked. It is
 * a screen of its own now — `about-screen.tsx`.
 *
 * Two deliberate departures from the server app's frame, both because this
 * assistant is not a sequence:
 *
 * - **No dots.** The server's wizard walks a person through an ordered set of
 *   screens; this one answers whichever question the machine is currently
 *   asking. There is no step 3 of 6, so a progress indicator would be
 *   inventing one.
 * - **No Back.** Every screen here is reachable from the machine's own state,
 *   so the way back is to fix the machine — or, for the two screens a user
 *   asks for, the screen's own Cancel.
 *
 * Centring is `min-h-full` + `justify-center` inside the scroll container
 * rather than `justify-center` on the container itself: a screen taller than
 * the region (Show Details open on a failure) then overflows DOWNWARD into the
 * scroll instead of past the unreachable top edge.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The parts of the frame the HOST owns, spread into whichever screen is up.
 *
 * Title, subtitle and the problem line are computed once in `app.tsx` from the
 * screen id and the probe, so every screen says them the same way; the icon,
 * the content and the bar belong to the screen itself.
 */
export interface FrameShell {
  title: string;
  subtitle?: string;
  problem?: string;
  confirm?: ReactNode;
}

export function Frame(props: {
  /** Title Case, one line, no trailing punctuation. */
  title: string;
  /** Sentence case, at most two lines. What will happen or why, never how. */
  subtitle?: string;
  /** The screen's glyph — 72px, `--primary` at 20%. */
  icon?: ReactNode;
  /** The action's own refusal, in the CLI's (or Rust's) words. */
  problem?: string;
  /** The one decision this screen asks for. */
  children?: ReactNode;
  /**
   * Pull the content up against the header, `mt-4` instead of the default
   * `mt-9`.
   *
   * The wide gap is right for a screen whose content is a distinct SECTION
   * under the question — a form, a checklist, a card that answers it. It is
   * wrong for a screen whose content CONTINUES the header, which is what the
   * status screen's badge is: a state chip and the sentence under it read as
   * part of the title, and nine units of nothing between them looks like a
   * layout that lost something. Opt-in per screen rather than a new default,
   * because every other screen here wants the section break.
   */
  tightContent?: boolean;
  /** Bottom bar, left: ghost buttons only. */
  barLeft?: ReactNode;
  /** Bottom bar, right: the one primary. */
  barRight?: ReactNode;
  /** A confirmation awaiting an answer, rendered under the content it is about. */
  confirm?: ReactNode;
}) {
  const { title, subtitle, icon, problem, children, barLeft, barRight, confirm, tightContent } = props;
  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center">
          {icon && (
            <div aria-hidden className="flex justify-center text-primary/20 [&_svg]:size-[72px]">
              {icon}
            </div>
          )}
          <h1 className="mt-6 text-center font-strong text-display leading-tight tracking-[-0.01em]">{title}</h1>
          {subtitle && <p className="mt-2 text-center text-body text-muted-foreground leading-normal">{subtitle}</p>}
          {/*
           * Above the content rather than below it: the problem is why the
           * screen still looks like this, so it has to be read before the
           * button that failed is pressed again.
           */}
          {problem && (
            <p role="status" className="mt-4 text-center text-warning text-detail leading-relaxed">
              {problem}
            </p>
          )}
          {children && <div className={cn("w-full", tightContent ? "mt-4" : "mt-9")}>{children}</div>}
          {confirm}
        </div>
      </div>
      <div className="flex h-[72px] shrink-0 items-center justify-between border-border border-t px-8">
        <div className="flex items-center gap-2">{barLeft}</div>
        <div className="flex items-center gap-2">{barRight}</div>
      </div>
    </div>
  );
}
