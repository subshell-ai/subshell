/**
 * The sentences a network act's RESULT renders, and the rule they obey.
 *
 * **The result-copy rule** (operator copy pass, 2026-09-16: "The user won't
 * know what TRUSTED_ORIGINS is"; amended the same day when the allowlist
 * became a live registry and no plugin act writes config.env any more):
 *
 * 1. **Product outcome first.** The subject is what the person can do or can
 *    no longer do — sign in, sign in no more — never a config key.
 * 2. **Names are pointers, not prose.** No sentence here names a key or a
 *    file, because nothing a plugin does touches one. The Service page's own
 *    field keeps its `TRUSTED_ORIGINS` pointer — that field IS the file.
 * 3. **Present tense, and only present tense.** The server trusts a network's
 *    addresses the moment the plugin reports them and stops the moment they
 *    are unpublished, left or disabled. Nothing awaits a restart, so no
 *    sentence may say "once the server restarts". (This rule used to be the
 *    opposite — "tense honesty" about a pending restart, with a notice and a
 *    Restart button under every result — and died with the restart.)
 * 4. **URLs stay** — they are the person's own addresses. "the trusted
 *    origins" as a noun phrase is gone; the long-hand "the addresses this
 *    server accepts sign-in from" appears only where a sentence cannot avoid it.
 *
 * Pure functions rather than JSX so the card's four result blocks and the
 * Disable confirmation speak one grammar, pinned without rendering a card.
 */

/** One, two, or many, in English: "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The publish announcement: where the other devices can sign in, now. */
export function publishedLine(name: string, urls: string[]): string {
  if (urls.length === 0) return `Published on ${name}.`;
  return `Published on ${name} — your other devices can sign in at ${andList(urls)} now.`;
}

/** "x no longer accepts sign-ins" / "x and y no longer accept sign-ins". */
function noLongerAccepts(origins: string[]): string {
  return `${andList(origins)} no longer ${origins.length === 1 ? "accepts" : "accept"} sign-ins`;
}

/**
 * The unpublish result. An empty list is a publish that had recorded no
 * origins — the sentence says the allowlist is unchanged rather than
 * "removed nothing", which reads as a failure of the act.
 */
export function unpublishedLine(name: string, origins: string[]): string {
  if (origins.length === 0) {
    return `Stopped publishing on ${name} — the addresses this server accepts sign-in from are unchanged.`;
  }
  return `Stopped publishing on ${name} — ${noLongerAccepts(origins)}.`;
}

/** The leave result, in the same grammar; leave is NetBird's normal path off the allowlist. */
export function leftLine(name: string, origins: string[]): string {
  if (origins.length === 0) return `Left ${name}.`;
  return `Left ${name} — ${noLongerAccepts(origins)}.`;
}

/**
 * The disabled card's one line. `count` is the row's address count when the
 * server sent a status for the disabled row, and undefined when it did not —
 * so the number appears only when it is a fact.
 */
export function disabledLine(count: number | undefined): string {
  if (count === undefined || count === 0) return "Disabled — its addresses are not offered or trusted.";
  if (count === 1) return "Disabled — its address is not offered or trusted.";
  return `Disabled — its ${count} addresses are not offered or trusted.`;
}

/**
 * What Disable takes away, for the confirmation — asked only when there is
 * something to name (`urls` non-empty; the caller skips the dialog otherwise).
 * `published` adds the publish that the server stops first
 * (`plugins.route.ts`: disabling a network plugin runs the unpublish sequence).
 */
export function disableDescription(name: string, urls: string[], published: boolean): string {
  const stop = `${andList(urls)} ${urls.length === 1 ? "stops" : "stop"} being offered and trusted for sign-in now`;
  const tail = " Enable it again from this card.";
  return published ? `This server stops publishing on ${name}, and ${stop}.${tail}` : `${stop}.${tail}`;
}
