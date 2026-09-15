/**
 * How this agent invokes ITSELF — the one place that decides it.
 *
 * The agent re-enters itself for two unrelated things: the service manager
 * runs `<self> run` (`service.ts`), and every pane it launches gets
 * `<self> mcp` registered as its MCP server — the `ready` frame reports
 * `selfInvocation("mcp")` and the control plane composes the registration
 * from it verbatim (the node writes what the plane sends, launch.ts). Both
 * have to answer the same awkward question — am I a compiled binary, or is
 * `bun` running my entry script? — and getting it wrong produces a command
 * that does not exist.
 *
 * They used to answer it separately, and only one of them answered it at all:
 * `execLine` branched correctly while the launch-side MCP path carried
 * `process.execPath` bare, so a source-run agent registered `bun mcp` for
 * its panes. `bun` has no `mcp` subcommand, so every pane launched from a
 * dev agent got an MCP entry that could never start (the final review's
 * R14a — the ready frame reporting the bare path let it ride straight into
 * the pane config once the node stopped recomputing).
 */
import { basename, resolve } from "node:path";

/** A command and its arguments, ready to spawn or to write into a unit file. */
export interface SelfInvocation {
  /** The executable — this binary, or the interpreter running it. */
  command: string;
  /** Everything after it, ending with the subcommand. */
  args: string[];
}

/** The pieces of the running process the decision is made from. */
export interface SelfInvokeDeps {
  /** `process.execPath` — the compiled agent, or the `bun` running it. */
  execPath: string;
  /** `process.argv[1]` — the entry script under an interpreter; virtual or absent otherwise. */
  argv1: string;
}

/**
 * A compiled Bun binary carries a VIRTUAL argv[1] (`/$bunfs/root/...`), so
 * "does argv1 look like a real entry script?" is what separates an interpreter
 * launch from a compiled one — an actual JS/TS extension, and not the bunfs
 * path. Mirrors the server's gate in `services/mcp-resolve.ts`.
 *
 * Exported because `update.ts` asks the same question of a token it read out
 * of an INSTALLED service definition rather than out of this process.
 */
export function looksLikeEntryScript(argv1: string): boolean {
  return !argv1.startsWith("/$bunfs/") && /\.(?:[mc]?[jt])s$/.test(argv1);
}

/**
 * Build `<self> <subcommand>`.
 *
 * Three rungs, in order, and the third is the one a bare entry-shape test
 * would miss:
 *
 * 1. The basename says `subshell` — a compiled agent under its own name.
 *    argv1 is ignored entirely, even when it looks like a script.
 * 2. argv1 is a real entry script — `bun <entry> <subcommand>`. ABSOLUTE,
 *    because a pane config spawns in the subshell's cwd where a relative
 *    argv[1] would not exist.
 * 3. Neither — a compiled binary someone renamed (the published artifact is
 *    `subshell-node-cli-<triple>`, and nothing stops a user calling it `agent`).
 *    Its argv1 is the bunfs path, so rung 2 must not claim it: treat it as
 *    compiled, which is what it is.
 */
export function selfInvocation(subcommand: string, deps?: SelfInvokeDeps): SelfInvocation {
  const prefix = selfInvokePrefix(deps);
  return { command: prefix.command, args: [...prefix.args, subcommand] };
}

/**
 * The same decision WITHOUT a subcommand — how to name this binary, full stop.
 *
 * This is what the `ready` frame reports, because the control plane re-enters
 * the agent for more than one thing: `mcp` for a pane's MCP registration, and
 * `report` for the harness hooks that tell it a turn finished or a
 * conversation id changed. Reporting the prefix once and appending the verb
 * there keeps that a single fact about the host; a field per verb would be the
 * same answer stored twice, free to drift.
 *
 * @param deps - the running process's pieces (default: this process's own)
 */
export function selfInvokePrefix(deps?: SelfInvokeDeps): SelfInvocation {
  const execPath = deps?.execPath ?? process.execPath;
  const argv1 = deps?.argv1 ?? process.argv[1] ?? "";
  if (basename(execPath).startsWith("subshell")) return { command: execPath, args: [] };
  if (looksLikeEntryScript(argv1)) return { command: execPath, args: [resolve(argv1)] };
  return { command: execPath, args: [] };
}
