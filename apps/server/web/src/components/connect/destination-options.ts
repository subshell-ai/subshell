import type { ComboboxOption } from "@/components/ui/combobox";
import type { SshRecentDestination } from "@/lib/ssh";

/**
 * The destination field's list, as pure data (the picker itself is the
 * panel's). The caller's recent destinations, and the picked machine's own config aliases - plus the
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
   * alias-is-display rule). Recent rows already own an alias.
   */
  aliasToken?: string;
}

/** The typed mirror row's group: none. It leads the list unlabelled. */
const TYPED_PREFIX = "typed:";
const RECENT_PREFIX = "recent:";
const CONFIG_PREFIX = "config:";

/** The group headers, one definition so the panel and its tests agree. */
export const RECENT_GROUP = "Recent";
/** `From mac mini's config` - the aliases belong to the machine, and the row says so. */
export const configGroupLabel = (machineName: string): string => `From ${machineName}'s config`;

/** The destination field's full list plus the per-row candidate map. */
export function buildDestinationOptions(args: {
  /** The caller's recent rows; newest first */
  recent: readonly SshRecentDestination[];
  /** The picked machine's alias names, fetched only while its gate is on */
  aliases: readonly string[];
  destinations?: readonly { alias: string; destination: string }[];
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
    args.recent.some((h) => h.destination === token || h.alias === token) || args.aliases.some((a) => a === token);
  if (text !== "" && !covered(text)) {
    push(`${TYPED_PREFIX}${text}`, { value: `${TYPED_PREFIX}${text}`, label: text }, { destination: text });
  }

  for (const row of args.recent) {
    const label = row.alias ?? row.destination;
    push(
      `${RECENT_PREFIX}${row.id}`,
      {
        value: `${RECENT_PREFIX}${row.id}`,
        label,
        group: RECENT_GROUP,
        reason: label !== row.destination ? row.destination : undefined,
        searchText: row.destination,
      },
      { destination: row.destination },
    );
  }
  if (args.machineName !== null) {
    for (const token of args.aliases) {
      push(
        `${CONFIG_PREFIX}${token}`,
        {
          value: `${CONFIG_PREFIX}${token}`,
          label: token,
          group: configGroupLabel(args.machineName),
          reason:
            args.destinations?.find((item) => item.alias === token)?.destination ??
            "Destination determined when connecting",
          searchText: args.destinations?.find((item) => item.alias === token)?.destination,
        },
        { destination: token, aliasToken: token },
      );
    }
  }
  return { options, candidates };
}
