import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NodeMcpEnabledWire, parseNodeMcpEnabled } from "@internal/subshell-protocol";
import { logger } from "./log.js";

/**
 * This node's MIRROR of the MCP-use switch: one word meaning "the subshell MCP
 * may run in panes launched on this machine".
 *
 * It is `ssh-enabled.ts` in mechanics and inverted in default, and the
 * inversion is the part to keep hold of. SSH gates a feature that is opt-in, so
 * an absent file refuses. MCP wiring predates its own switch: a machine that
 * has never been pushed a value has to carry on wiring, so an ABSENT file
 * allows and only an explicit `on: false` refuses. Fold that off-file into
 * "absent" the way the ssh module folds its own off-file away, and an owner's
 * refusal stops meaning anything.
 *
 * **The plane is the sole writer.** There is no `subshell mcp-enabled` verb:
 * this is the same decision the SSH and preview gates reserve for a browser, an
 * owner, and an audit row. The mirror's only readers are the launch executor
 * (which drops wiring material it was sent) and the `mcp` CLI verb (which
 * refuses to start), plus the `ready` report and the heartbeat belt that let
 * the plane notice the two copies disagreeing.
 *
 * Nothing compares stamps across the two ends: the plane pushes its row, and
 * this copy converges by obeying.
 */

/** File name inside the agent data dir. */
const FILE = "mcp-enabled.json";

/** Absolute path of the MCP-use mirror for a data dir. */
export function mcpEnabledPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * What the mirror says, as the four answers a caller must tell apart.
 *
 * `absent`, `on` and `off` are the file's three true states, and `off` is a
 * kind here in a way it is not in the ssh mirror: the refusal IS the news, so
 * it carries its stamp rather than dissolving into silence. `unreadable` is the
 * fourth: a file that exists and does not parse. It refuses, like the family,
 * because a plane that said no should not be answered with wiring on the
 * strength of a broken file, and it reports itself so the plane can repair it.
 */
export type McpEnabledRead =
  /** No file at all: wiring continues exactly as it did before the switch existed. */
  | { kind: "absent" }
  /** The mirror parsed and says yes, with the plane's stamp verbatim. */
  | { kind: "on"; changedAt: string }
  /** The mirror parsed and says no. Every pane launched here loses its MCP wiring. */
  | { kind: "off"; changedAt: string }
  /** The file exists but is not a state: REFUSED, reported under the file's mtime. */
  | {
      kind: "unreadable";
      /** The file's mtime, ISO, or absent when the stat failed too. */
      changedAt?: string;
    };

/**
 * The gate's answer, spelled once so no call site can drift into its own
 * reading of the four kinds: everything refuses except a present mirror that
 * has not said no.
 */
export function mcpAllowed(read: McpEnabledRead): boolean {
  return read.kind === "absent" || read.kind === "on";
}

/**
 * Reads the mirror. Total: every failure answers rather than throwing, because
 * each caller sits on a path where a throw costs more than an answer, the
 * launch executor and the `mcp` verb included.
 *
 * The parse is the WIRE parser, not a private one: the file holds exactly what
 * travels, and a second validator here would be a second opinion about what
 * `{ on, changedAt }` means.
 */
export function readMcpEnabled(dataDir: string): McpEnabledRead {
  const file = mcpEnabledPath(dataDir);
  if (!existsSync(file)) return { kind: "absent" };
  try {
    const state = parseNodeMcpEnabled(JSON.parse(readFileSync(file, "utf8")));
    if (!state) throw new SyntaxError("not an mcp-enabled state");
    return state.on ? { kind: "on", changedAt: state.changedAt } : { kind: "off", changedAt: state.changedAt };
  } catch (err) {
    logger.withError(err).warn(`mcp-enabled: ${file} unreadable; treating this node as MCP-DISABLED`);
    // The mtime, never `now`: this answer refuses, so the plane has to hear
    // about it (a row that says on pushes the clean file that repairs it), and
    // the mtime is the one timestamp nobody invented. A fresh `now` per read
    // would defeat the report memo and put a frame on the wire every heartbeat,
    // forever.
    const changedAt = mtimeOf(file);
    return changedAt ? { kind: "unreadable", changedAt } : { kind: "unreadable" };
  }
}

/**
 * A file's mtime as an ISO stamp. Total: every caller treats it as optional and
 * a throw would cost the whole read.
 */
function mtimeOf(file: string): string | undefined {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * The wire value a read is worth announcing, or `undefined` when there is
 * nothing truthful to say.
 *
 * Silence means ALLOW on the plane's side of this flag, so `absent` has nothing
 * to announce: it agrees with a default row, and pushing an echo would only
 * mint a file the machine never needed. An `off` mirror always announces,
 * because that is the disagreement the owner asked for and the plane must be
 * able to see it land.
 *
 * One known corner: an unreadable file whose stat ALSO fails reports nothing,
 * and so the plane hears "allow" from a machine that is refusing. It is the
 * only reading that is both truthful and unrepeatable, and it self-heals at
 * the next reconnect, when the stat works or the row's push rewrites the file.
 */
export function reportableMcpEnabled(read: McpEnabledRead): NodeMcpEnabledWire | undefined {
  if (read.kind === "on") return { on: true, changedAt: read.changedAt };
  if (read.kind === "off") return { on: false, changedAt: read.changedAt };
  if (read.kind === "unreadable" && read.changedAt) return { on: false, changedAt: read.changedAt };
  return undefined;
}

/**
 * Persists the mirror, 0600, via temp + rename.
 *
 * Atomic for the reason the other mirrors give and one sharper: the launch
 * executor reads this while composing a pane, so a half-written file parses as
 * corrupt, and a corrupt file refuses wiring rather than racing it.
 *
 * The `state` is stored VERBATIM. The plane sent it; re-stamping here would
 * make the two copies differ by exactly the link delay, and the next `ready`
 * would report a disagreement this process invented.
 */
export function writeMcpEnabled(dataDir: string, state: NodeMcpEnabledWire): NodeMcpEnabledWire {
  const file = mcpEnabledPath(dataDir);
  const body: NodeMcpEnabledWire = { on: state.on, changedAt: state.changedAt };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return body;
}
