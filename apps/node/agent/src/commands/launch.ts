import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assembleHarnessCommand,
  buildHarnessCommand,
  enforceMode,
  findBinary,
  type McpRegistration,
  type ProfileDefinition,
} from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { resolveLaunchPlugin } from "../launch-plugin.js";
import { log } from "../log.js";
import { pathAllowed, realpathRoots } from "../path-policy.js";
import { selfInvocation } from "../self-invoke.js";
import { isSubshellId } from "../subshell-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { startExitWatcher } from "./report.js";

/**
 * The `launch` executor (spec 2026-08-31 §6.4/§7) — the agent-side twin of
 * `LocalLauncher.launch`. Byte-parity rule: local and remote panes are
 * assembled by the SAME env assembly (curatedEnv ⊕ subshellEnv ⊕ profile.env
 * ⊕ mcp.env) over the plugin argv (resume pin included). The inversion
 * (spec 2026-09-10 §5) added WHERE the argv comes from: when the frame
 * carries `cmd.argv`, the node spawns what the control plane built, binding
 * only the node-owned fact into it — the binary path, freshly resolved
 * against `cmd.resolve` at this instant. Absent `cmd.argv`, the node builds
 * the argv from its own plugin exactly as it always has; that fallback is
 * deliberate (it keeps an old-server/new-agent pair working) and is
 * Task 7's removal target.
 */

/**
 * Start one harness subshell on this node.
 *
 * Step order is contractual (interfaces, brief §Task 4): id gate → harness →
 * binary → MCP file (policy-gated) → meta record → pane argv assembly →
 * `newSubshell` (rollback on throw) → log attach (strict by default;
 * `bestEffortLog` downgrades the whole attach region) → optional resize
 * (cosmetic) → exit watcher. A strict log-attach throw PROPAGATES (the
 * dispatcher answers `{ok:false}`) exactly like `LocalLauncher.launch`
 * throwing from `pipePane` — but the live pane's meta record STAYS (parity
 * with the local throw path; cleanup is the control plane's).
 *
 * @param ctx - the per-daemon execution context (config, tmux, meta, ws seam)
 * @param cmd - the verified `launch` command
 * @returns `{ok:true}` on acceptance; `{ok:false, error}` on a refused input;
 * infrastructure throws surface through `dispatchCommand` as `{ok:false}`.
 */
export async function execLaunch(ctx: CommandContext, cmd: Cmd<"launch">): Promise<CommandResult> {
  // Id gate FIRST (same rule as resolveSocket): the meta store throws on a
  // malformed id and every path below interpolates it — never touch harness,
  // fs, or tmux with an id the control plane could not have minted.
  if (!isSubshellId(cmd.subshellId)) return { ok: false, error: "invalid subshell id" };

  // The node's OWN allowlist, checked before anything is resolved or spawned.
  // Signed commands prove who asked, never whether the directory is permitted
  // — so this is the check a compromised control plane cannot talk its way
  // past (see allowed-dirs.ts). Empty rules = unrestricted.
  if (!(await launchDirAllowed(cmd.cwd, readAllowedDirs(ctx.config.dataDir)))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.cwd}` };
  }

  // Resolved against what THIS node has INSTALLED, not against the registry
  // compiled into the binary. A signature proves who sent the launch, never
  // whether this machine offers the plugin (see launch-plugin.ts).
  const resolved = await resolveLaunchPlugin(ctx.config.dataDir, cmd.harnessId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const harness = resolved.plugin;

  // (2b) Where the argv comes from — the inversion switch (spec 2026-09-10 §5).
  // With `cmd.argv` present the plugin's buildCommand never runs: the ONE fact
  // the control plane cannot know — where the binary lives on THIS machine at
  // THIS moment — arrives as a RULE (`cmd.resolve`), not a path, because an
  // inventory can be minutes old and predate an upgrade (that freshness is the
  // whole reason §5 kept late binding). Substitution is STRICT ELEMENT
  // EQUALITY, the argv-parity gate's binding rule (Task 3): an entry EQUAL to
  // HARNESS_BINARY_PLACEHOLDER is the binary; a longer token that merely
  // CONTAINS that text is plugin content and must ride untouched. Absent
  // argv, everything below is the pre-inversion contract — the fallback
  // Task 7 deletes.
  let paneArgv: { sent: string[] } | { localBinary: string };
  if (cmd.argv !== undefined) {
    let argv = cmd.argv;
    if (argv.includes(HARNESS_BINARY_PLACEHOLDER)) {
      // The node's OWN lookup ladder (env override → PATH → known paths →
      // version managers → login shell), driven by the sent rule.
      const path = cmd.resolve
        ? await findBinary(cmd.resolve.binaryName, cmd.resolve.envOverride ?? "", cmd.resolve.knownPaths ?? [])
        : null;
      if (!path) {
        // Message CLASS contract, SAME bytes as the fallback below: the
        // backend maps `/binary missing/i` on a launch failure to an
        // inventory refresh (spec §6.2).
        return { ok: false, error: `harness binary missing: ${cmd.harnessId}` };
      }
      argv = argv.map((entry) => (entry === HARNESS_BINARY_PLACEHOLDER ? path : entry));
    }
    paneArgv = { sent: argv };
  } else {
    const binary = await harness.findBinary();
    if (!binary) {
      // Message CLASS contract: the backend maps `/binary missing/i` on a launch
      // failure to an inventory refresh (spec §6.2) — keep the prefix stable.
      return { ok: false, error: `harness binary missing: ${cmd.harnessId}` };
    }
    paneArgv = { localBinary: binary };
  }

  // (3) MCP registration. The AGENT writes the file either way — its own path
  // policy and 0600 discipline are node controls, not plugin knowledge. What
  // the inversion moved is the SOURCE of the dialect. Sent-argv path:
  // `mcp.fileContent` and `mcp.env` ride the wire verbatim (spec §5; the args
  // half is already inside the sent argv), so no plugin function runs and the
  // drift rule does not fire. No-argv fallback: the frozen pre-inversion wire
  // carries only {path, fileContent}, so the AGENT re-runs the plugin locally,
  // `harness.mcpRegistration({command: …, args:["mcp"]}, path)` — the exact
  // function the control plane runs host-side (mcp-launch.ts) — making the
  // dialect byte-identical ON THE MACHINE THE PANE LIVES ON. The wire's
  // fileContent was computed against `ready.executablePath` (Task 1); when it
  // disagrees with the locally regenerated content the wire is stale (an old
  // ready, a moved binary) — one warn line and the LOCAL content wins, while
  // `reg`'s args+env are ALWAYS the agent's own. This whole local branch
  // goes away with Task 7, and the drift rule with it.
  let reg: McpRegistration | undefined;
  let mcpPaneEnv: Record<string, string> | undefined;
  if (cmd.mcp) {
    if (!(await pathAllowed(cmd.mcp.path, await realpathRoots([ctx.config.dataDir])))) {
      return { ok: false, error: "mcp path refused" };
    }
    let content = cmd.mcp.fileContent;
    if (cmd.argv !== undefined) {
      mcpPaneEnv = cmd.mcp.env; // the sent dialect is the whole dialect
    } else {
      // `selfInvocation`, not a bare `process.execPath`: under a source run that
      // is the `bun` binary, and `bun mcp` is not a command — every pane from a
      // dev agent would get an MCP entry that can never start. Same decision the
      // service unit's ExecStart makes, made in one place.
      reg = harness.mcpRegistration?.(selfInvocation("mcp"), cmd.mcp.path);
      if (reg && content !== reg.fileContent) {
        log(
          `mcp config drift for subshell ${cmd.subshellId}: wire content != agent-local dialect; using the local content`,
        );
        content = reg.fileContent;
      }
    }
    // Canonical location is <dataDir>/mcp/<id>.json (subshell-meta mcpPath twin);
    // mkdir the parent whatever the (already policy-passed) path names.
    const dir = dirname(cmd.mcp.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(cmd.mcp.path, content, { mode: 0o600 });
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

  // (5) §6.4 assembly + (6) spawn. The wire profile is the structural mirror
  // (`ProfileDefinitionWire`) — same field names, the frame validator already
  // ran — so the cast is the intended decode, exactly where the brief pins it.
  // Both branches finish in `assembleHarnessCommand` (buildHarnessCommand
  // delegates to it), so the env assembly is literally ONE function for the
  // local build and the sent argv alike — §6.4 byte-identity, extended to
  // a command line this machine never built.
  const profile = cmd.profile as unknown as ProfileDefinition;
  try {
    const paneCmd =
      "sent" in paneArgv
        ? assembleHarnessCommand(paneArgv.sent, profile, cmd.subshellEnv, mcpPaneEnv)
        : buildHarnessCommand(
            harness,
            paneArgv.localBinary,
            cmd.cwd,
            profile,
            cmd.subshellName,
            cmd.subshellEnv,
            reg,
            cmd.harnessSession,
          );
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
      ctx.tmux.resizeWindow(cmd.socket, cmd.subshellId, cmd.cols, cmd.rows);
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
