/**
 * The cells every row of the Components table shares.
 *
 * Extracted because the desktop, Server and node rows all state the same two
 * quantities the same way — and a version cell whose mobile behaviour drifted
 * between rows is exactly the "two places answering one question" defect this
 * repo treats as a bug.
 */

/** What every cell says when a version is not known. */
export const DASH = "—";

/**
 * One version cell (Running or Newest). Hidden below `sm`, where the pair
 * folds into the name cell instead — the same two-track collapse
 * `installed-plugins-card.tsx` gives its badge and switch.
 */
export function VersionCell({ value }: { value: string }) {
  return <div className="hidden font-mono text-detail text-muted-foreground sm:block">{value}</div>;
}

/**
 * The phone's version pair, rendered inside the name cell where the two
 * columns would have stood. Nothing to say when neither version is known:
 * "— → —" is noise, and the absence is already what the row means.
 */
export function MobilePair({ running, newest }: { running: string; newest: string }) {
  if (running === DASH && newest === DASH) return null;
  return (
    <p className="truncate font-mono text-detail text-muted-foreground sm:hidden">
      {running} → {newest}
    </p>
  );
}

/**
 * The rule between rows. Full-width and `aria-hidden`, exactly as the plugin
 * card's are: the rows carry no border of their own, and a rule between them
 * is what keeps a multi-line row from reading as two.
 */
export function RowRule() {
  return <div aria-hidden className="col-span-full border-t" />;
}
