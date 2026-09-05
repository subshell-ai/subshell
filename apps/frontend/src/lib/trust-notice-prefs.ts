/**
 * Per-DEVICE state for the trust notices (`trust-notices.ts`) — the same tier
 * as `swipe-nav-pref` and `terminal-font-size`: what you have already read on
 * this screen is a property of the screen, not of the account.
 *
 * Two independent things live here:
 *
 * - **Seen-marks.** A notice's banner shows once per exposure and then stays
 *   quiet, whether it faded on its own or was dismissed. The KEY carries the
 *   exposure it was raised for, so widening a share re-raises it.
 * - **The master switch.** "Don't show these banners" for people who know
 *   their setup and don't want the reminder.
 *
 * Neither can silence the header ICONS. Suppressing a banner is a choice about
 * interruption; the disclosure itself stays visible, permanently, in the
 * chrome — which is what makes it safe to offer the switch at all.
 *
 * Every access is try/catch'd: private-mode Safari throws on `localStorage`
 * outright, and a warning subsystem that can crash the page it warns on is
 * worse than no warning.
 */

/** Storage value meaning "off"; everything else (or nothing) means on. */
const OFF = "0";

/** Master switch: whether trust banners appear at all on this device. */
const BANNERS_KEY = "subshell.trustBanners";

/** JSON array of `dismissKey` strings already seen on this device. */
const SEEN_KEY = "subshell.trustNoticesSeen";

/**
 * Upper bound on remembered seen-marks, oldest evicted first.
 *
 * The keys are per-subshell and per-exposure, so on a busy instance the set
 * grows without limit. A cap keeps this a bounded convenience: the worst case
 * of eviction is that a very old subshell shows its banner once more.
 */
const SEEN_CAP = 300;

/** Whether trust banners are enabled on this device (default on). */
export function trustBannersEnabled(): boolean {
  try {
    return localStorage.getItem(BANNERS_KEY) !== OFF;
  } catch {
    return true;
  }
}

/**
 * Persist this device's banner choice.
 * @returns the stored state, so callers bind their switch to truth not intent
 */
export function setTrustBannersEnabled(on: boolean): boolean {
  try {
    localStorage.setItem(BANNERS_KEY, on ? "1" : OFF);
  } catch {
    // Storage refused: the choice still holds for this page load.
  }
  return on;
}

/** The seen set, or an empty array for absent/corrupt/blocked storage. */
function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written value must not throw on every render.
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Whether this exact exposure has already been shown on this device. */
export function noticeSeen(dismissKey: string): boolean {
  return readSeen().includes(dismissKey);
}

/**
 * Marks one notice as seen. Idempotent — re-marking does not reorder the set,
 * so a notice that keeps being re-rendered cannot push others out of the cap.
 */
export function markNoticeSeen(dismissKey: string): void {
  const seen = readSeen();
  if (seen.includes(dismissKey)) return;
  // Oldest-first eviction: `slice` from the end keeps the most recent marks.
  const next = [...seen, dismissKey].slice(-SEEN_CAP);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the banner will reappear next load. Acceptable — the
    // alternative is failing the render.
  }
}

/**
 * Forgets every seen-mark, so all banners surface again on this device.
 * Exposed for the preferences card: turning the switch back on should mean
 * "start reminding me", not "resume a set of dismissals I can't see".
 */
export function resetSeenNotices(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // Nothing to do — an unwritable store has nothing remembered in it either.
  }
}
