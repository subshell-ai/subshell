import { getRequestlessContext } from "@/app/context.js";
import { getNodeMcpEnabled } from "@/modules/nodes/mcp-enabled.js";

/**
 * The one question the launch asks about the subshell MCP: may this account's
 * pane, on this machine, be wired with it?
 *
 * Two switches answer, and **off wins on either of them**. An account saying
 * no is that person deciding their panes should not carry the tool surface or
 * pay its context cost; a node saying no is the machine's owner deciding
 * nothing of the MCP runs on their hardware, and that refusal is not something
 * a tenant can talk past. So there is no precedence to reason about, only a
 * veto: an enabled account on a refused node gets nothing, and the node's
 * owner never has to trust a plane that forgot to ask.
 *
 * Both defaults are ON, which is what makes an upgrade quiet: a row that was
 * never written reads allowed at both levels, and every pane lands exactly as
 * it did before the switches existed.
 *
 * This answers the plane's half. A node whose mirror says no also strips
 * wiring material out of a launch frame that carries it anyway
 * (`apps/node/agent/src/commands/launch.ts`), and refuses to start `subshell
 * mcp` at all, which is what makes the machine's refusal true for a harness
 * that registered the server on its own months ago.
 *
 * @param userId - the pane's OWNER, read from the row, never the caller's
 *   preference substituted: a restart reaches this from an edit-grantee or the
 *   auto-restart sweep, and the owner's switch is what gets asked every time
 * @param nodeId - the machine the pane will run on, `local` included
 */
export async function mcpWiringAllowed(userId: string, nodeId: string): Promise<boolean> {
  const accountEnabled = await getRequestlessContext().repos.userMeta.getMcpEnabled(userId);
  // The account's own refusal needs no second read, and skipping the node read
  // keeps the refusal cheap on a path that runs for every launch.
  if (!accountEnabled) return false;
  return getNodeMcpEnabled(nodeId);
}
