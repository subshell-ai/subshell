/**
 * The one numeric semver compare this app needs.
 *
 * `1.10.0` is newer than `1.9.0`, which a string compare denies — and every
 * version gate here asks "is the installed agent older than X", so the
 * gates share this rather than each carrying a private copy (the autostart
 * gate had the only one until the un-enroll gate arrived).
 *
 * Prerelease and build suffixes are out of the product's vocabulary —
 * releases are plain `X.Y.Z` — and the split on `.` and `-` degrades them to
 * their leading numbers rather than failing, which is the safe direction for
 * a gate: an unparseable piece reads 0, and version gates assume capable
 * when the version is unknown at all (the caller's own rule, argued in
 * `autostart-gate.ts`).
 */

/** Whether `a` sorts older than `b` numerically, segment by segment. */
export function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
