import type { ComboboxOption } from "@/components/ui/combobox";
import type { SshSavedHost } from "@/lib/ssh";

/**
 * The destination field's list, as pure data (the picker itself is the
 * panel's). Three fed groups per spec 2026-10-07 §7: the caller's saved rows,
 * their recent rows, and the picked machine's own config aliases - plus the
 * one row that makes the field accept free text: a row mirroring whatever is
 * typed. Picking is the commitment; the candidate map says what each row
 * MEANS on the wire, so display aliases never leak into the launch body.
 */

/** What choosing one row commits the launch to. */
export interface DestinationCandidate {
  /** The token sent as `destination` (an alias from the config, or a concrete host) */
  destination: string;
  /**
   * The alias display token, set ONLY for rows that came from the machine's
   * config list - the save sends it as the row's display override (§7's
   * alias-is-display rule). Saved and recent rows already own an alias.
   */
  aliasToken?: string;
}

/** The typed mirror row's group: none. It leads the list unlabelled. */
const TYPED_PREFIX = "typed:";
const SAVED_PREFIX = "saved:";
const RECENT_PREFIX = "recent:";
const CONFIG_PREFIX = "config:";

/** The group headers, one definition so the panel and its tests agree. */
export const SAVED_GROUP = "Saved";
export const RECENT_GROUP = "Recent";
/** `From mac mini's config` - the aliases belong to the machine, and the row says so. */
export const configGroupLabel = (machineName: string): string => `From ${machineName}'s config`;

/** The destination field's full list plus the per-row candidate map. */
export function buildDestinationOptions(args: {
  /** The caller's saved rows (newest first, as the server sends them) */
  saved: readonly SshSavedHost[];
  /** The caller's recent rows; rows already Saved are dropped from Recent */
  recent: readonly SshSavedHost[];
  /** The picked machine's alias names, fetched only while its gate is on */
  aliases: readonly string[];
  /** The picked machine's display name, for the config group header */
  machineName: string | null;
  /** The field's current typed text - the mirror row's source */
  typed: string;
}): { options: ComboboxOption[]; candidates: Map<string, DestinationCandidate> } {
  const options: ComboboxOption[] = [];
  const candidates = new Map<string, DestinationCandidate>();

  const push = (id: string, option: ComboboxOption, candidate: DestinationCandidate): void => {
    options.push(option);
    candidates.set(id, candidate);
  };

  // The free-text mirror first: whatever is typed is offered as a row the
  // click commits. Suppressed when a real row already carries the same
  // token - the row would be a duplicate of a choice already on screen.
  const text = args.typed.trim();
  const covered = (token: string): boolean =>
    args.saved.some((h) => h.destination === token || h.alias === token) ||
    args.recent.some((h) => h.destination === token || h.alias === token) ||
    args.aliases.some((a) => a === token);
  if (text !== "" && !covered(text)) {
    push(`${TYPED_PREFIX}${text}`, { value: `${TYPED_PREFIX}${text}`, label: text }, { destination: text });
  }

  const savedIds = new Set(args.saved.map((h) => h.id));
  for (const row of args.saved) {
    const label = row.alias ?? row.destination;
    push(
      `${SAVED_PREFIX}${row.id}`,
      { value: `${SAVED_PREFIX}${row.id}`, label, group: SAVED_GROUP, searchText: row.destination },
      { destination: row.destination },
    );
  }
  for (const row of args.recent) {
    if (savedIds.has(row.id)) continue; // the destination reads once (the favorites precedent)
    const label = row.alias ?? row.destination;
    push(
      `${RECENT_PREFIX}${row.id}`,
      { value: `${RECENT_PREFIX}${row.id}`, label, group: RECENT_GROUP, searchText: row.destination },
      { destination: row.destination },
    );
  }
  if (args.machineName !== null) {
    for (const token of args.aliases) {
      push(
        `${CONFIG_PREFIX}${token}`,
        { value: `${CONFIG_PREFIX}${token}`, label: token, group: configGroupLabel(args.machineName) },
        { destination: token, aliasToken: token },
      );
    }
  }
  return { options, candidates };
}
