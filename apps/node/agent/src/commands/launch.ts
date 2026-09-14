import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assembleHarnessCommand, enforceMode, findBinary, type PresetDefinition } from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { log } from "../log.js";
import { pathAllowed, realpathRoots } from "../path-policy.js";
import { isSubshellId } from "../subshell-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { startExitWatcher } from "./report.js";

/**
 * The `launch` executor (spec 2026-08-31 §6.4/§7) — the agent-side twin of
 * `LocalLauncher.launch`. The node holds NO plugin concept (inversion spec
 * 2026-09-10 §5/§6): the frame carries the whole command line the control
 * plane built from the plugin IT holds, and this machine contributes exactly
 * two facts of its own — the directory allowlist, and the binary path,
 * freshly resolved against `cmd.resolve` at this instant (late binding is the
 * whole reason the rule travels instead of a path: an inventory can be
 * minutes old and predate an upgrade).
 *
 * `cmd.argv` and `cmd.resolve` are REQUIRED on the frame (protocol 3): the
 * parser refuses a launch without either before dispatch reaches this
 * function, so the command line and its binary rule are always present here.
 */

/**
 * Start one harness subshell on this node.
 *
 * Step order is contractual (interfaces, brief §Task 4): id gate → allowlist
 * gate → argv + binary resolution → MCP file (policy-gated) → meta record →
 * pane argv assembly → `newSubshell` (rollback on throw) → log attach
 * (strict by default; `bestEffortLog` downgrades the whole attach region) →
 * optional resize (cosmetic) → exit watcher. A strict log-attach throw
 * PROPAGATES (the dispatcher answers `{ok:false}`) exactly like
 * `LocalLauncher.launch` throwing from `pipePane` — but the live pane's meta
 * record STAYS (parity with the local throw path; cleanup is the control
 * plane's).
 *
 * @param ctx - the per-daemon execution context (config, tmux, meta, ws seam)
 * @param cmd - the verified `launch` command
 * @returns `{ok:true}` on acceptance; `{ok:false, error}` on a refused input;
 * infrastructure throws surface through `dispatchCommand` as `{ok:false}`.
 */
export async function execLaunch(ctx: CommandContext, cmd: Cmd<"launch">): Promise<CommandResult> {
  // Id gate FIRST (same rule as resolveSocket): the meta store throws on a
  // malformed id and every path below interpolates it — never touch fs or
  // tmux with an id the control plane could not have minted.
  if (!isSubshellId(cmd.subshellId)) return { ok: false, error: "invalid subshell id" };

  // The node's OWN allowlist, checked before anything is resolved or spawned.
  // Signed commands prove who asked, never whether the directory is permitted
  // — so this is the check a compromised control plane cannot talk its way
  // past (see allowed-dirs.ts). Empty rules = unrestricted.
  if (!(await launchDirAllowed(cmd.cwd, readAllowedDirs(ctx.config.dataDir)))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.cwd}` };
  }

  // The argv is the whole command line, built on the control plane from the
  // plugin it holds (inversion §5). Substitution is STRICT ELEMENT EQUALITY,
  // the argv-parity gate's binding rule (Task 3): an entry EQUAL to
  // HARNESS_BINARY_PLACEHOLDER is the binary; a longer token that merely
  // CONTAINS that text is plugin content and must ride untouched. Both this
  // and the resolve rule are REQUIRED frame fields since protocol 3, so the
  // interim fail-closed guards of the v2 transition are gone — the parser
  // refuses those shapes before dispatch.
  let argv = cmd.argv;
  if (argv.includes(HARNESS_BINARY_PLACEHOLDER)) {
    // The node's OWN lookup ladder (env override → PATH → known paths →
    // version managers → login shell), driven by the sent rule.
    const path = await findBinary(cmd.resolve.binaryName, cmd.resolve.envOverride ?? "", cmd.resolve.knownPaths ?? []);
    if (!path) {
      // Message CLASS contract: the backend maps `/binary missing/i` on a
      // launch failure to an inventory refresh (spec §6.2) — keep the prefix
      // byte-identical. (Same bytes the pre-inversion fallback answered with;
      // the fallback itself is gone.)
      return { ok: false, error: `harness binary missing: ${cmd.harnessId}` };
    }
    argv = argv.map((entry) => (entry === HARNESS_BINARY_PLACEHOLDER ? path : entry));
  }

  // (3) MCP registration. The AGENT writes the file — its own path policy and
  // 0600 discipline are node controls, not plugin knowledge. The dialect is
  // pure wire data now: `mcp.fileContent` and `mcp.env` ride the frame
  // verbatim (spec §5; the args half is already inside the sent argv), so no
  // plugin function runs here and the old wire-vs-local drift rule has no
  // second source to disagree with.
  let mcpPaneEnv: Record<string, string> | undefined;
  if (cmd.mcp) {
    if (!(await pathAllowed(cmd.mcp.path, await realpathRoots([ctx.config.dataDir])))) {
      return { ok: false, error: "mcp path refused" };
    }
    mcpPaneEnv = cmd.mcp.env; // the sent dialect is the whole dialect
    // Canonical location is <dataDir>/mcp/<id>.json (subshell-meta mcpPath twin);
    // mkdir the parent whatever the (already policy-passed) path names.
    const dir = dirname(cmd.mcp.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(cmd.mcp.path, cmd.mcp.fileContent, { mode: 0o600 });
    await enforceMode(cmd.mcp.path, 0o600); // Task-2 re-tightening: umask cannot leak bits here
  }

  // (4) Record meta FIRST: path policy + socket lookup must see the cwd even
  // while later steps are in flight (and the rollback below has something to
  // roll back). `record` creates <dataDir>/subshells with 0700.
  await ctx.meta.record({
    subshellId: cmd.subshellId,
    cwd: cmd.cwd,
    socket: cmd.socket,
    harnessId: cmd.harnessId,
    name: cmd.subshellName,
    startedAt: new Date(ctx.nowMs()).toISOString(),
  });

  // (5) §6.4 env assembly over the SENT argv — the same
  // `assembleHarnessCommand` the local build finished in, so the env assembly
  // is literally ONE function (§6.4 byte-identity, extended to a command line
  // this machine never built).
  // The wire preset is the structural mirror (`PresetDefinitionWire`) —
  // same field names, the frame validator already ran — so the cast is the
  // intended decode, exactly where the brief pins it.
  const preset = cmd.preset as unknown as PresetDefinition;
  try {
    const paneCmd = assembleHarnessCommand(argv, preset, cmd.subshellEnv, mcpPaneEnv);
    ctx.tmux.newSubshell(cmd.socket, cmd.subshellId, cmd.cwd, paneCmd);
  } catch (err) {
    await ctx.meta.forget(cmd.subshellId); // nothing spawned — no orphan root for the policy
    throw err; // dispatcher answers {ok:false}; mirrors LocalLauncher's throw path
  }

  // (7) Log attach — the pane-log dir ensure + pipe-pane pair, ONE guard so
  // the strict and best-effort paths can never drift (same single-home rule as
  // LocalLauncher's `#ensureLogDir`).
  const logFile = ctx.meta.logPath(cmd.subshellId);
  const attachLog = async (): Promise<void> => {
    const subshellsDir = join(ctx.config.dataDir, "subshells");
    await mkdir(subshellsDir, { recursive: true, mode: 0o700 });
    await enforceMode(subshellsDir, 0o700);
    ctx.tmux.pipePane(cmd.socket, cmd.subshellId, logFile);
  };
  if (cmd.bestEffortLog === true) {
    // Revive parity (Task 1's wire flag, twin of LaunchPlan.bestEffortLog):
    // the pane is live and the row must come back even when the replay log
    // refuses to attach — and "attach" is BOTH steps, a throwing mkdir is as
    // fatal as a throwing pipe-pane, so one wrap covers the pair.
    try {
      await attachLog();
    } catch (err) {
      log(
        `log attach (dir/pipe-pane) failed for ${cmd.subshellId}; reviving without the log pipe: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    await attachLog(); // STRICT (createSubshell parity): a throw fails the launch
  }

  // (8) Initial geometry — cosmetic: a refused resize must not fail a live pane.
  if (cmd.cols !== undefined && cmd.rows !== undefined) {
    try {
      await ctx.tmux.resizeWindow(cmd.socket, cmd.subshellId, cmd.cols, cmd.rows);
    } catch (err) {
      log(
        `resize ${cmd.cols}x${cmd.rows} failed for ${cmd.subshellId} (cosmetic, continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // (9) Death reporting from here on is the shared watcher's job (report.ts).
  // The socket rides straight in from the wire — no meta re-read microseconds
  // after step (4) wrote it. LOAD-BEARING ORDER: the meta record (step 4) is
  // written BEFORE this call — report.ts's residual-window guard counts on a
  // relaunch having re-asserted its meta by the time a stale tick could
  // forget it. Do not sink startExitWatcher below a meta gap.
  startExitWatcher(ctx, cmd.subshellId, cmd.socket);
  return { ok: true };
}
