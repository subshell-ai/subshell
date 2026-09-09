import type { Node } from "@/types/node";
import type { SubshellView } from "@/types/subshell";

/**
 * What a subshell discloses, and to whom — derived, not stored.
 *
 * Two facts about a subshell are invisible in the UI but decide whether it is
 * safe to type a secret into it:
 *
 * - **Whose machine it runs on.** Everything a pane prints is written to a
 *   plaintext transcript on the HOST, and the subshell's bearer token rides in
 *   the tmux start command there. Whoever owns that machine's OS user can read
 *   both. On a node someone else enrolled, that person is not you.
 * - **Who it is shared with.** A `view` grant streams the full pane output —
 *   including the scrollback that existed before the share; an `edit` grant
 *   adds the keystroke stream.
 *
 * Both are legitimate, deliberate features. Neither is discoverable from
 * looking at a terminal, which is the whole reason this module exists: the
 * disclosure has to be visible at the moment someone is deciding what to type.
 *
 * This module is PURE — it maps state to copy. Whether a notice has been seen
 * lives in `trust-notice-prefs.ts`, and the rendering in
 * `components/trust-notice-banner.tsx` / `components/trust-indicators.tsx`.
 */

/** Which disclosure a notice is about. */
export type TrustNoticeKind = "foreign-node" | "shared";

/** One disclosure worth telling the user about. */
export interface TrustNotice {
  /** Which disclosure this is. */
  kind: TrustNoticeKind;
  /**
   * Storage key for "this has been seen". Carries the state it was raised
   * for, so a CHANGE in exposure — a subshell shared with three more people —
   * surfaces the banner again rather than staying silently dismissed.
   */
  dismissKey: string;
  /** Full sentence for the banner: what is exposed, to whom, and why. */
  banner: string;
  /** Short form for the always-present header icon's tooltip. */
  tooltip: string;
  /** Accessible label for the icon (the tooltip is not reachable by every AT). */
  label: string;
}

/**
 * The node a subshell runs on is someone else's machine.
 *
 * Deliberately restricted to `agent` nodes. A non-admin's access to the
 * seeded `local` node is `edit` (via its Everyone grant), not `owner`, so the
 * strict rule would raise this on the default node for every ordinary user in
 * every session — and a warning that is always on is a warning nobody reads.
 * The control-plane operator's reach over `local` is a property of the whole
 * instance, documented in the security model rather than repeated on each pane.
 */
function foreignNodeNotice(subshell: SubshellView, node: Node | undefined): TrustNotice | null {
  if (node?.kind !== "agent" || node.access === "owner") return null;
  const where = node.name || node.id;
  return {
    kind: "foreign-node",
    dismissKey: `foreign-node:${subshell.id}:${node.id}`,
    banner:
      `This subshell runs on ${where}, a machine you don't own. Everything this terminal prints is written to ` +
      `a transcript on that host, and this subshell's credentials live there too, both readable by whoever ` +
      `controls it. Only run it here if you trust that machine's owner.`,
    tooltip:
      `Runs on ${where}, a machine you don't own. Its owner can read this terminal's output and this ` +
      `subshell's credentials.`,
    label: `Runs on ${where}, a machine you don't own`,
  };
}

/** How many people, spelled for a sentence. */
function audience(count: number, everyone: boolean): string {
  if (everyone) return "everyone signed in to this instance";
  return count === 1 ? "1 other person" : `${count} other people`;
}

/**
 * The subshell is shared, so its pane is not private.
 *
 * Raised for the OWNER as much as for a guest: the owner is the one deciding
 * whether to keep typing secrets into it, and "I forgot this was shared" is
 * the failure this exists to prevent.
 */
function sharedNotice(subshell: SubshellView): TrustNotice | null {
  // Optional on the wire (a payload from before the field existed): absent is
  // read as private, never as "unknown, warn anyway".
  const count = subshell.shareCount ?? 0;
  const everyone = subshell.sharedWithEveryone ?? false;
  if (count <= 0) return null;
  const who = audience(count, everyone);
  const owned = subshell.access === "owner";
  return {
    kind: "shared",
    // The count is part of the key: widening the audience is new information,
    // not a notice that was already dismissed.
    dismissKey: `shared:${subshell.id}:${count}:${everyone}`,
    banner: owned
      ? `You've shared this subshell with ${who}. They can read everything this terminal shows, including the ` +
        `scrollback from before you shared it, and anyone with edit access sees what you type.`
      : `This subshell belongs to someone else and is shared with ${who}. Its owner can read everything this ` +
        `terminal shows, including what you type into it.`,
    tooltip: owned
      ? `Shared with ${who}. They can read this terminal's full output.`
      : `Someone else's subshell, shared with ${who}. The owner can read everything here.`,
    label: owned ? `Shared with ${who}` : "Someone else's subshell",
  };
}

/**
 * Every disclosure that applies to one subshell, in the order they should be
 * shown. Node trust comes first: it is the wider exposure of the two, and it
 * is the one the user cannot revoke.
 *
 * @param subshell - the subshell being viewed (undefined while loading)
 * @param nodes - the caller's visible nodes, for resolving `subshell.nodeId`
 */
export function trustNoticesFor(subshell: SubshellView | undefined, nodes: Node[] | undefined): TrustNotice[] {
  if (!subshell) return [];
  const node = nodes?.find((candidate) => candidate.id === subshell.nodeId);
  return [foreignNodeNotice(subshell, node), sharedNotice(subshell)].filter(
    (notice): notice is TrustNotice => notice !== null,
  );
}
