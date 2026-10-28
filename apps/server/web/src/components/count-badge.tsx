/** Above this the badge says `9+`; the exact list is the picker's job. */
const BADGE_CAP = 9;

/** The count's one spelling: `9+` past the cap, so the painted chip and the
 *  announced name can never disagree about how many there are. */
export function badgeText(count: number): string {
  return count > BADGE_CAP ? "9+" : String(count);
}

/** Decorative: the trigger announces the count. */
export function CountBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-strong text-detail text-primary-foreground"
    >
      {badgeText(count)}
    </span>
  );
}
