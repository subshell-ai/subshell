/**
 * The assistants' shared frame (spec 2026-09-21): one visual specification,
 * now one implementation the two desktop apps' bundled pages both consume.
 *
 * The geometry is the client app's `Frame`
 * (`apps/client/desktop/ui/src/components/assistant/frame.tsx`), written out
 * here rather than inherited: 1024x720 window, a 560px column centred in the
 * scroll region, a 72px bottom bar with a hairline top, primary right and
 * ghost left. The classes are the same Tailwind token utilities, and each
 * app's stylesheet carries the `@theme` mappings that generate them.
 *
 * The type roles, not sizes, are the contract: `text-display` for the title,
 * `text-body` for the subtitle, `text-detail` for the problem line — the same
 * roles at the same sizes on every surface (`bun run lint:design` holds them
 * together).
 *
 * This package is a leaf: it imports nothing of ours, and a screen that needs
 * more than this shell composes it in its own app. `Rail` joins in wave 2.
 */
import type { ReactElement, ReactNode } from "react";

/**
 * The strings the HOST computes for whichever screen is up.
 *
 * The empty string HIDES its line, so a screen that has nothing to say omits
 * it rather than reserving a gap — the same rule the client's optional props
 * follow, expressed over one object so a screen passes its three strings in
 * one place.
 */
export interface AssistantStrings {
  /** Title Case, one line, no trailing punctuation. */
  title: string;
  /** Sentence case, at most two lines. What will happen or why, never how. */
  subtitle: string;
  /** The screen's or action's own refusal, in the CLI's (or Rust's) words. */
  problem: string;
}

export function Frame(props: {
  /** Title, subtitle and problem; the empty string hides its line. */
  strings: AssistantStrings;
  /** The screen's glyph — only Welcome renders art today. */
  art?: ReactNode;
  /** The content region: the one decision this screen asks for. */
  children?: ReactNode;
  /** Bottom bar, left: ghost buttons only. */
  barLeft?: ReactNode;
  /** Bottom bar, right: the one primary. */
  barRight?: ReactNode;
  /**
   * Replay the screen-change entrance when it CHANGES (spec 2026-09-21; the
   * old page's `replayEnter`, which ran on every screen change, manual or
   * automatic). The scroll region — art, title, subtitle and content, the old
   * `<main>`'s extent, the bar deliberately excluded — is keyed on the value,
   * so a change remounts it and the `.screen-enter` animation the app's
   * stylesheet carries plays on insertion. `undefined` (the default) never
   * remounts anything: a host that does not track screen changes gets none of
   * this.
   */
  entranceKey?: number;
}): ReactElement {
  const { strings, art, children, barLeft, barRight, entranceKey } = props;
  return (
    <div className="flex h-screen flex-col">
      {/* The class rides the key: both arrive together on the first replay,
          so the animation plays on insertion exactly as the old forced-reflow
          restart made it, and never on the boot frame's first paint. */}
      <div
        key={entranceKey}
        className={
          entranceKey !== undefined
            ? "screen-enter flex-1 overflow-y-auto px-8 py-8"
            : "flex-1 overflow-y-auto px-8 py-8"
        }
      >
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center">
          {art && (
            <div aria-hidden className="flex justify-center">
              {art}
            </div>
          )}
          <h1 className="mt-6 text-center font-strong text-display leading-tight tracking-[-0.01em]">
            {strings.title}
          </h1>
          {strings.subtitle !== "" && (
            <p className="mt-2 text-center text-body text-muted-foreground leading-normal">{strings.subtitle}</p>
          )}
          {/*
           * Above the content rather than below it: the problem is why the
           * screen still looks like this, so it has to be read before the
           * button that failed is pressed again.
           */}
          {strings.problem !== "" && (
            <p role="status" className="mt-4 text-center text-warning text-detail leading-relaxed">
              {strings.problem}
            </p>
          )}
          {children && <div className="mt-9 w-full">{children}</div>}
        </div>
      </div>
      <div className="flex h-[72px] shrink-0 items-center justify-between border-border border-t px-8">
        <div className="flex items-center gap-2">{barLeft}</div>
        {/*
         * `data-slot` is how a page's global keys find this half of the bar
         * without reaching into class names: the server assistant's
         * Enter-presses-the-primary handler queries
         * `[data-slot="bar-right"] button.primary`.
         */}
        <div data-slot="bar-right" className="flex items-center gap-2">
          {barRight}
        </div>
      </div>
    </div>
  );
}
