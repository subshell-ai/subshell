import { isNodeSubshellId } from "@internal/subshell-protocol";

/**
 * The backend half of the node-path id gate (audit 2026-09, item 7).
 *
 * The agent has always checked `isNodeSubshellId` before interpolating a
 * subshell id into a path (`subshell-meta.ts` aliases the protocol guard);
 * since 2026-09-23 the control plane checks the SAME guard at its own
 * composition sites, so the promise "a hostile `../../../../x` never reaches
 * path interpolation" holds on both sides of the link instead of resting on
 * the fact that every id today is a server-minted uuid.
 *
 * A leaf module importing only the protocol package, deliberately: the two
 * callers cannot import each other (`mcp-launch → remote-launcher →
 * lib/context → subshells.service → subshell-manager → mcp-launch` is the
 * pinned cycle the path-template duplicate exists to break), and one
 * predicate's WORDING belongs in one place even when the template is
 * duplicated.
 *
 * This is a server-side INVARIANT, not user-input handling: a non-conforming
 * id reaching these sites means the row was never minted through the create
 * path, so it throws like the other impossible-state guards and the caller
 * gets a 500, never a composed path.
 */
export function assertNodePathId(id: string): void {
  if (!isNodeSubshellId(id)) {
    throw new Error(`refusing to compose a node-side path from a non-conforming subshell id: ${JSON.stringify(id)}`);
  }
}
