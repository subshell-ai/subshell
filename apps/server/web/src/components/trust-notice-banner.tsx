import { type JSX, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Button } from "@/components/ui/button";
import { markNoticeSeen, noticeSeen, trustBannersEnabled } from "@/lib/trust-notice-prefs";
import type { TrustNotice } from "@/lib/trust-notices";
import { cn } from "@/lib/utils";

/**
 * The INTERRUPTING half of the trust disclosure: an amber strip that says, in
 * a sentence, what this subshell exposes and to whom — then gets out of the
 * way.
 *
 * It shows once per exposure, per device. It fades on its own after
 * {@link VISIBLE_MS}, or immediately when dismissed, and either way the
 * exposure is marked seen so it does not come back. Re-raising it on every
 * visit would train exactly the reflex that makes warnings useless — and the
 * disclosure has a permanent home anyway, the header icon
 * (`trust-indicators.tsx`), which no setting can turn off.
 *
 * Notices are keyed by the exposure they describe, not merely by the subshell,
 * so widening a share raises a fresh banner: that is new information, not a
 * notice already dismissed.
 */

/** How long the banner stays up before fading on its own. */
export const VISIBLE_MS = 5_000;

/** Fade duration; the banner is dropped only after this elapses. */
const FADE_MS = 400;

export interface TrustNoticeBannerProps {
  /** Notices for the subshell in view, from `trustNoticesFor`. */
  notices: TrustNotice[];
  /** Extra classes for the wrapper (positioning is the caller's business). */
  className?: string;
  /**
   * Dwell before the fade starts. Defaults to {@link VISIBLE_MS}; no caller in
   * the app passes it.
   *
   * It exists for the tests. The contract worth asserting is "the banner goes
   * away on its own", which needs REAL timers — asserting it through fake ones
   * tests the mock instead. But at the 5 s default that case spends 5.4 s of
   * wall clock, and on a loaded CI runner it blew past even a 15 s budget
   * (measured: 17.2 s, one failed run on 2026-09-07). A shorter dwell keeps the
   * real-timer contract and removes the flake, rather than raising the budget
   * and moving the threshold.
   */
  visibleMs?: number;
}

export function TrustNoticeBanner({
  notices,
  className,
  visibleMs = VISIBLE_MS,
}: TrustNoticeBannerProps): JSX.Element | null {
  /**
   * The exposure currently on screen, or null for none. Chosen ONCE per set of
   * notices, in the effect below — never re-derived during render, so marking
   * one seen cannot make the next one pop up in its place mid-view.
   */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * The effect must re-run when the EXPOSURES change, not when the parent
   * re-renders. `notices` is a fresh array each render for any caller that
   * does not memoize, and re-running would restart the fade timers forever —
   * a banner that never goes away. So the identity is this joined key, and
   * the array itself is reached through a ref (not reactive, so it cannot
   * re-trigger the effect behind the key's back).
   */
  const _noticeKeys = notices.map((notice) => notice.dismissKey).join("|");
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  useEffect(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];

    // Several notices can be active at once (a shared subshell on someone
    // else's node). They QUEUE rather than stack: two amber strips over a
    // terminal bury the thing being warned about, and the icons show both
    // regardless. The next one surfaces on the next visit.
    const next = noticesRef.current.find((notice) => !noticeSeen(notice.dismissKey));
    if (!next || !trustBannersEnabled()) {
      setActiveKey(null);
      return;
    }

    const key = next.dismissKey;
    setActiveKey(key);
    setFading(false);
    const retire = (): void => {
      // Marked seen only once the banner has actually had its run on screen.
      // Writing the mark at mount would silence a notice for a navigation
      // that never rendered it.
      markNoticeSeen(key);
      setActiveKey(null);
    };
    timers.current = [setTimeout(() => setFading(true), visibleMs), setTimeout(retire, visibleMs + FADE_MS)];
    return () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    };
  }, [visibleMs]);

  const active = notices.find((notice) => notice.dismissKey === activeKey);
  if (!active) return null;
  // Bound outside the closure: a hoisted function declaration does not carry
  // the guard's narrowing of `active`.
  const shownKey = active.dismissKey;

  /** Dismiss now, through the same fade the timer uses — one mechanism, not two. */
  function dismiss(): void {
    for (const timer of timers.current) clearTimeout(timer);
    setFading(true);
    timers.current = [
      setTimeout(() => {
        markNoticeSeen(shownKey);
        setActiveKey(null);
      }, FADE_MS),
    ];
  }

  return (
    <ErrorBanner
      tone="warning"
      className={cn("transition-opacity duration-300", fading ? "opacity-0" : "opacity-100", className)}
      message={active.banner}
      action={
        <Button variant="ghost" size="sm" className="h-6 px-2 text-detail" onClick={dismiss}>
          Got it
        </Button>
      }
    />
  );
}
