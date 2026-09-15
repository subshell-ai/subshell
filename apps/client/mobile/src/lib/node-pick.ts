import type { Node } from "@/types/node";

/**
 * Whether a node is pickable right now — the mobile mirror of the web
 * `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx`
 * `isSelectable`; change one, change both. Any share grants launch
 * (`nodeCanLaunch` — deliberately not the subshell rule,
 * spec §2), EXCEPT where the server says otherwise: `canLaunch` is false on
 * the control-plane host once an admin switches launching off there, which
 * applies to admins too. That row used to be the only visible-but-unlaunchable
 * one; maintenance makes it ordinary, since any node in a window is listed and
 * unpickable (spec 2026-09-14). Mobile needs no maintenance field of its own
 * to honour that — the server folds it into `canLaunch`, and the reason text
 * the web picker shows is the part this screen goes without. Without reading it, an admin who threw that switch
 * would still see the Server chip here and collect a 403 on Start. An
 * OFFLINE agent is shown disabled for its own reason: launching there 409s
 * `NODE_OFFLINE`, and offering a target we know is down would only invite a
 * confusing failure. (The pick list can always be stale — the 409 path covers
 * the race.) Shared by the chip row and `pickNodeDefault` so "selectable" is
 * defined exactly once.
 */
export function isSelectable(n: Node): boolean {
  return (n.kind === "local" || n.status === "online") && n.canLaunch;
}

/**
 * The node the picker should hold once the list has loaded — the mobile
 * mirror of the web `new-subshell-form.tsx` `pickNodeDefault`; change one,
 * change both. Keep the current pick while it stays selectable; else the
 * pick vanished (or went unselectable) and exactly one option remains
 * (auto-pick — not a decision worth forcing); else `""` — an explicit choice
 * is due and Start stays blocked until it happens. Pure so the fallback
 * matrix is testable without a device.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Whether the node pick has SETTLED: the list has not answered yet, or it has
 * and {@link pickNodeDefault} would leave the current pick where it is.
 *
 * The agent default reads a PER-NODE inventory, so it must not run while the
 * node is still about to move under it. Both effects fire on the commit where
 * the nodes list first arrives, in declaration order, and the default writes
 * `harnessId` — which makes its own "only while nothing is picked" guard
 * early-return forever afterwards. Without this gate a viewer whose `local`
 * is visible-but-unlaunchable gets an agent chosen from the control-plane
 * host's inventory and then re-homed onto an agent node that cannot run it:
 * greyed-but-selected, Start enabled, and a 409 at launch. Web composes both
 * writes into one commit instead (`new-subshell-form.tsx`); this is the
 * mobile mirror of that guarantee — change one, change both.
 */
export function nodePickSettled(nodes: Node[] | undefined, current: string): boolean {
  if (!nodes) return true;
  // `""` is the re-home's "an explicit choice is due" answer, and it is a
  // FIXED POINT of `pickNodeDefault` — so the equality below calls it settled
  // while no node is chosen at all. It is not: `installedOnNode` finds no row
  // for `""`, reads every agent as unknown-and-therefore-usable, and the
  // default fills from an all-unknown inventory — which is the same
  // greyed-but-selected end state this gate exists to prevent, reached by a
  // different road. Nothing is lost by waiting: the effect re-runs on
  // `nodeId`, so the default fires the moment the user picks, and Start is
  // blocked until they do.
  if (current === "") return false;
  return pickNodeDefault(nodes, current) === current;
}

/**
 * Whether `node` could run `harnessId` — the mobile mirror of web's
 * `harnessFitsNode` (`src/lib/subshell-compat.ts`); change one, change both.
 * Two "blocks nothing" cases, both deliberate: no agent chosen yet (there is
 * nothing to fail against), and a node row from an older server carrying no
 * inventory at all — unknown is not a refusal, and the launch 409 is the
 * backstop either way. An entry that exists but is not installed IS a
 * refusal: the node declared the plugin and its binary was not seen.
 *
 * Web's type makes `harnesses` required and mobile's optional, which is the
 * only reason this is not the identical function.
 */
export function nodeRunsHarness(node: Node, harnessId: string | null): boolean {
  if (harnessId === null) return true;
  if (!node.harnesses) return true;
  return node.harnesses.some((h) => h.harnessId === harnessId && h.installed);
}
