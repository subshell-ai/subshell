import type { SubshellIndicator } from "@/lib/subshell-indicator";
import { INDICATOR_BAND_ORDER, INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellNodeGroup } from "@/lib/subshell-node-groups";
import type { SubshellView } from "@/types/subshell";

/**
 * One section of the Subshells page — the unit BOTH views segment by once the
 * group-by selector decides the axis (machine or status, operator ask
 * 2026-09-24). Deliberately NOT a node-group type: a status band has no node,
 * and `key` is the stable identity whatever produced the section.
 *
 * `label`/`title` follow the tile heading's contract (`TileSection` renders
 * no tooltip when they are equal): machine sections carry the label ladder's
 * pair (name + full-id reveal only when the name did not resolve), band
 * sections carry the same word twice — an id would reveal nothing.
 */
export interface SubshellSection {
  key: string;
  label: string;
  title: string;
  subshells: SubshellView[];
}

/** The sidebar's node grouping, in the shape both views render. */
export function sectionsByNode(groups: readonly SubshellNodeGroup[]): SubshellSection[] {
  return groups.map((g) => ({ key: g.nodeId, label: g.label, title: g.title, subshells: g.subshells }));
}

/**
 * Sections by STATE, in {@link INDICATOR_BAND_ORDER} (urgency first), skipping
 * empty bands. The key is the SHARED indicator the dots render, not the DB
 * status — so a section heading and the dot beside a row in it can never
 * disagree about the same subshell, which is the whole reason the band order
 * and the words live in `subshell-indicator.ts` rather than here.
 *
 * Input order inside a band survives (bucketing is push-order), so callers
 * pre-sort with `sortByStatus`/`priorityRunning` and this only draws the
 * boundaries.
 */
export function sectionsByStatus(list: readonly SubshellView[]): SubshellSection[] {
  const buckets = new Map<SubshellIndicator, SubshellView[]>();
  for (const s of list) {
    const band = subshellIndicator(s);
    const rows = buckets.get(band);
    if (rows) rows.push(s);
    else buckets.set(band, [s]);
  }
  return INDICATOR_BAND_ORDER.filter((band) => buckets.has(band)).map((band) => {
    const heading = bandHeading(band);
    return { key: band, label: heading, title: heading, subshells: buckets.get(band) ?? [] };
  });
}

/** The band word, headed: `INDICATOR_LABEL` is sentence-case for the dot's
 *  title; a section heading starts with a capital like its machine siblings. */
function bandHeading(band: SubshellIndicator): string {
  const word = INDICATOR_LABEL[band];
  return word.charAt(0).toUpperCase() + word.slice(1);
}
