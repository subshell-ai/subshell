import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assembleHarnessCommand,
  buildSshConfigPath,
  enforceMode,
  exitHookFor,
  findBinary,
  type PresetDefinition,
  paneEnvFor,
} from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER, NODE_RESULT_MAINTENANCE } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { log } from "../log.js";
import { readMaintenance, reportableMaintenance } from "../maintenance.js";
import { mcpAllowed, readMcpEnabled } from "../mcp-enabled.js";
import { pathAllowed, realpathRoots } from "../path-policy.js";
import { PREVIEW_DISPLAY_UNSUPPORTED } from "../preview/display.js";
import { getVirtualDisplayEnabled } from "../preview/flags.js";
import type { PreviewScreenHandle } from "../preview/ports.js";
import { selfInvocation } from "../self-invoke.js";
import { isSubshellId } from "../subshell-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { PREVIEW_NODE_OFF } from "./preview-ports-exec.js";
import { reportMaintenance, startExitWatcher } from "./report.js";
import { gateOpen, SSH_GATE_REFUSAL } from "./ssh-shared.js";

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
 * Take the MCP dialect's own argv out of a command line the plane composed.
 *
 * Every harness splices its registration in as ONE contiguous run, so the run
 * is found by exact sequence match and removed whole. Matching the run rather
 * than each token by value is the point:
 * codex's dialect is three `-c` overrides interleaved with their values, and
 * deleting every argv entry that merely EQUALS one of them would also eat a
 * `-c` belonging to something else.
 *
 * An argv that does not contain the run comes back untouched. That is not a
 * failure to strip: it means the run was never in there, and removing
 * something else on the strength of a near-miss would damage the command.
 *
 * @param argv - the plane-built command line, placeholder included or resolved
 * @param args - the registration's own argv, from the same frame
 * @returns argv without that one run, or argv unchanged
 */
export function withoutMcpArgs(argv: string[], args: string[] | undefined): string[] {
  if (!args || args.length === 0) return argv;
  const start = argv.findIndex((_, i) => args.every((token, offset) => argv[i + offset] === token));
  if (start === -1) return argv;
  return [...argv.slice(0, start), ...argv.slice(start + args.length)];
}

/**
 * Start one harness subshell on this node.
 *
 * Step order is contractual (interfaces, brief §Task 4): id gate → allowlist
 * gate → argv + binary resolution → MCP file (policy-gated) → ssh config
 * (byte-derived path, policy-gated; spec 2026-10-07 decision 4) → meta record
 * → pane argv assembly → `newSubshell` (rollback on throw) → log attach
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

  // Maintenance (spec 2026-09-14 §4.2), ahead of the allowlist: this machine
  // was taken out of service, so WHICH directory was asked for is not the
  // question. The node enforces it from its own file rather than trusting the
  // plane's gate — defence in depth for the same reason the allowlist is
  // here, plus the plain race that the plane may not have learned yet.
  //
  // The event is what makes a refusal CONVERGE: the plane writes its row from
  // a stamp the node reported, never from one it invented for a refusal it
  // did not expect. An UNREADABLE file converges the same way, under the
  // file's own mtime (maintenance.ts) — a refusal the plane never hears about
  // leaves it launching into a 409 forever. Only a file this process could
  // not even stat refuses silently: there is no stamp to send.
  //
  // The error is the BARE constant: the plane compares `detail` by equality,
  // and a suffix (however helpful) reads there as an ordinary launch failure.
  const maintenance = readMaintenance(ctx.config.dataDir);
  if (maintenance.kind === "unreadable" || (maintenance.kind === "state" && maintenance.state.on)) {
    const state = reportableMaintenance(maintenance);
    if (state) reportMaintenance(ctx, state);
    return { ok: false, error: NODE_RESULT_MAINTENANCE };
  }

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
  // The owner's MCP switch, asked HERE and not only on the plane. The plane's
  // row is the record and it composes no wiring for a node that says no, but a
  // frame can still arrive carrying `mcp`: composed moments before the flip, or
  // from a plane that never consulted the row at all. Dropping the material is
  // the answer, and the pane still launches. Failing the launch would punish
  // the user for a disagreement between two machines, and refusing is already
  // complete on its own: the dialect is only ever the three things this block
  // handles, the file, the argv run that names it, and the wiring env.
  const mcp = cmd.mcp;
  const mcpRefusedHere = mcp !== undefined && !mcpAllowed(readMcpEnabled(ctx.config.dataDir));
  if (mcp && mcpRefusedHere) {
    log(
      `mcp-enabled mirror refuses wiring on this node: dropped MCP registration for subshell ${cmd.subshellId}; launching without it`,
    );
    argv = withoutMcpArgs(argv, mcp.args);
  }

  let mcpPaneEnv: Record<string, string> | undefined;
  if (mcp && !mcpRefusedHere) {
    if (!(await pathAllowed(mcp.path, await realpathRoots([ctx.config.dataDir])))) {
      return { ok: false, error: "mcp path refused" };
    }
    mcpPaneEnv = mcp.env; // the sent dialect is the whole dialect
    // Canonical location is <dataDir>/mcp/<id>.json (subshell-meta mcpPath twin);
    // mkdir the parent whatever the (already policy-passed) path names.
    const dir = dirname(mcp.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    if (mcp.files) {
      const companionDir = `${mcp.path}.d`;
      if (!(await pathAllowed(companionDir, await realpathRoots([ctx.config.dataDir]))))
        return { ok: false, error: "integration path refused" };
      await mkdir(companionDir, { recursive: true, mode: 0o700 });
      await enforceMode(companionDir, 0o700);
      for (const [name, content] of Object.entries(mcp.files)) {
        const target = `${companionDir}/${name}`;
        if (
          !/^[a-zA-Z0-9_-]+\.(mjs|py|json)$/.test(name) ||
          !(await pathAllowed(target, await realpathRoots([ctx.config.dataDir])))
        )
          return { ok: false, error: "integration path refused" };
        await writeFile(target, content, { mode: 0o600 });
        await enforceMode(target, 0o600);
      }
    }
    await writeFile(mcp.path, mcp.fileContent, { mode: 0o600 });
    await enforceMode(mcp.path, 0o600); // Task-2 re-tightening: umask cannot leak bits here
  }

  // (3b) SSH pane config (spec 2026-10-07 decision 4). The MCP block above is
  // the posture this mirrors — file-placement is a NODE control, not plugin
  // knowledge — with one sharper rule: the MCP path is the plane's to name,
  // the ssh path is not. This machine derives it
  // (`buildSshConfigPath(dataDir, id)`), and refuses unless the frame's
  // `configPath` is BYTE-equal to that derivation. The plane may name nothing
  // else: `buildSshConfigPath` composes from the two facts each side already
  // holds (dataDir, id), so the file always lands where this machine's own
  // exit sweep and the plane's delete-side `subshellArtifacts` will both look
  // for it — and a plane that could point the write anywhere would turn a
  // signed launch into an arbitrary-file write.
  if (cmd.ssh) {
    // The arm that actually runs ssh(1) asks the same fail-closed local mirror
    // every other SSH arm asks first. The plane's row is not enough: a corrupt
    // or absent `ssh-enabled.json` is the exact fail-closed condition the
    // `ssh_enabled` heartbeat reports, and this launch would otherwise spawn an
    // outbound ssh with the account's SSH_AUTH_SOCK exported into the pane.
    if (!gateOpen(ctx)) return { ok: false, error: SSH_GATE_REFUSAL };
    const derivedPath = buildSshConfigPath(ctx.config.dataDir, cmd.subshellId);
    if (cmd.ssh.configPath !== derivedPath) {
      // A bare message, no path interpolation: the byte-equality failure is
      // the whole fact, and the paths here are this machine's own layout.
      return { ok: false, error: "ssh config path refused: not the derived path" };
    }
    if (!(await pathAllowed(derivedPath, await realpathRoots([ctx.config.dataDir])))) {
      return { ok: false, error: "ssh config path refused" };
    }
    const dir = dirname(derivedPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(derivedPath, cmd.ssh.fileContent, { mode: 0o600 });
    await enforceMode(derivedPath, 0o600); // umask cannot leak bits past this
  }

  // (3c) Virtual display gate (pane-preview spec §5, Task 7). A `screen`
  // launch is refused BEFORE the meta record and before anything spawns, in
  // the same order the allocation itself runs: platform first (a machine
  // without an X stack says so by name), then the mirror (switch off refuses
  // with the one voice every preview entry point uses, the constant pinned
  // in preview-ports-exec.ts), then the loud refusal a context without the
  // display registry earns - silently dropping the screen the plane asked
  // for would be the bug here, not an error message. openFor checks the same
  // gates again for its own sake; this block is the launch-side "refuse
  // before the record", which is the half reviewers flagged.
  if (cmd.screen) {
    if (ctx.previewDisplays && !(await ctx.previewDisplays.readiness(cmd.screen.provider)).supported)
      return { ok: false, error: PREVIEW_DISPLAY_UNSUPPORTED };
    if (!getVirtualDisplayEnabled(ctx.config.dataDir)) return { ok: false, error: PREVIEW_NODE_OFF };
    if (!ctx.previewDisplays) {
      return { ok: false, error: "preview display registry unavailable in this daemon context" };
    }
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
  let screenHandle: PreviewScreenHandle | undefined;
  try {
    // (5a) Allocate the pane's display BEFORE assembling (spec §5, Task 7):
    // the refusal must fail the launch with its named reason before tmux is
    // asked for a pane, and the allocated numbers are what the env layer
    // below carries. The handle is echoed in the launch result (Task 1's
    // `screen` echo) so the plane learns the display without a re-read.
    if (cmd.screen && ctx.previewDisplays) {
      screenHandle = await ctx.previewDisplays.openFor(cmd.subshellId, cmd.screen);
    }
    // Provider-owned launch settings stay on the node; only the public screen
    // descriptor is returned in the acknowledgement.
    const displayEnv = screenHandle ? ctx.previewDisplays?.launchEnv(cmd.subshellId) : undefined;
    const paneCmd = assembleHarnessCommand(argv, preset, cmd.subshellEnv, mcpPaneEnv, displayEnv);
    // The pane reports its OWN death to the control plane, through the same
    // builder the plane's local launcher uses (spec 2026-09-19 §4.3). It needs
    // no frame and no protocol bump: the pane already holds the plane's
    // address and its own bearer token in `subshellEnv` — the same pair the
    // MCP server and the attention hooks authenticate with — so the report
    // goes straight to `/api/subshells/:id/exit`.
    //
    // The 2 s exit watcher stays as the backstop, for the deaths a hook cannot
    // report: a SIGKILLed tmux server, a machine that lost power, an agent
    // that was not running when the pane went.
    // The SAME layers the pane command is assembled from — including the
    // preset's, which this used to omit while the plane omitted the MCP
    // wiring too. Two partial slices of one precedence chain is how a report
    // ends up aimed at a different plane from the pane that sent it. The
    // display layer rides this map too: the hook string itself keeps only the
    // credential keys, but one map for both consumers is the agreement, so
    // the report is built from the same env the pane got.
    const exitHook = exitHookFor(selfInvocation("report"), paneEnvFor(cmd.subshellEnv, preset, mcpPaneEnv, displayEnv));
    ctx.tmux.newSubshell(cmd.socket, cmd.subshellId, cmd.cwd, paneCmd, exitHook);
  } catch (err) {
    // Roll back in the order things were created: a display this launch
    // opened but never got a pane for is closed FIRST (its pids are ours),
    // then the meta record goes as it always has.
    if (screenHandle) await ctx.previewDisplays?.closeFor(cmd.subshellId);
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
    // The capture child is this agent's own `pane-log` verb — the same
    // self-invocation the exit hook above uses, a different word. It flushes
    // every read, where a bare `cat >>` would freeze the live view on a host
    // whose `cat` is uutils coreutils (buffers partial writes to a regular file).
    ctx.tmux.pipePane(cmd.socket, cmd.subshellId, logFile, selfInvocation("pane-log"));
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
  // The `screen` echo (Task 1's launch-result member): a screen pane's
  // answer carries the allocated pair so the plane can open its Screen
  // affordance without a `preview_ports_get` round trip; a plain launch
  // answers exactly `{ ok: true }`, as it always did.
  return screenHandle ? { ok: true, data: { screen: screenHandle } } : { ok: true };
}
