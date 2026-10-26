import {
  lingerVerdict,
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  nodeVersionSupported,
} from "@internal/subshell-protocol";
import { collectStatus, type StatusDeps, type StatusSettingKey } from "@/modules/server/status.js";
import { type ServiceState, SYSTEMD_UNIT_NAME } from "@/modules/server/supervision.js";

/**
 * The human rendering — one aligned line per fact. Names the BUILD first: the
 * question status exists to answer, in the byte-identical string the `version`
 * subcommand prints.
 */
export function runStatus(log: (line: string) => void, deps: StatusDeps): void {
  const v = collectStatus(deps);
  const field = (key: StatusSettingKey): void => {
    const s = v.settings[key];
    log(`${key.padEnd(20)} = ${s.value}  (${s.source})`);
    // Indented under the value it is about, and printed VERBATIM — both views
    // render what the object says rather than computing a second wording.
    for (const problem of s.problems ?? []) log(`${" ".repeat(23)}! ${problem.reason}`);
  };

  log(`subshell-server ${v.version}`);
  log(`config.env: ${v.configEnv.path} (${v.configEnv.exists ? "present" : "missing"})`);
  field("SERVER_PORT");
  field("HOST");
  field("APP_BASE_URL");
  field("TRUSTED_ORIGINS");
  field("DATABASE_PATH");
  // Never echo the secret — masked/missing is all status reveals.
  const secretText = v.authSecret.state === "set" ? "set (masked)" : "MISSING";
  log(`BETTER_AUTH_SECRET   = ${secretText}  (${v.authSecret.source})`);
  log(`tmux                 = ${v.tmux ?? "NOT FOUND: install tmux (apt install tmux / brew install tmux)"}`);
  log(
    v.mcp
      ? `mcp entrypoint       = ${[v.mcp.command, ...v.mcp.args].join(" ")}  (via ${v.mcp.source})`
      : `mcp entrypoint       = UNRESOLVED; subshell create will fail; ${v.mcpError}`,
  );
  log(`plugin registry      = ${v.pluginRegistry}`);
  const { published, total, dir, claims } = v.nodeArtifacts;
  log(
    `node artifacts       = ${published}/${total} published (${dir})` +
      (published < total ? ", install.sh 404s for the rest" : ""),
  );
  // One line per shelf copy that CANNOT CONNECT (the same two facts the serve
  // resolver enforces: this protocol, this floor) or answers nothing at all.
  // Silence means every copy could honestly be served, and a warning nobody
  // needs is the noise that makes warnings unread.
  for (const [target, facts] of Object.entries(claims)) {
    if (facts === null) {
      log(`  ${target}: the copy answers no version; the release wins whenever one is available`);
    } else if (facts.protocol !== NODE_PROTOCOL_VERSION) {
      log(
        `  ${target}: copy is ${facts.version} speaking protocol v${facts.protocol}, this server speaks ` +
          `v${NODE_PROTOCOL_VERSION}: machines installing from it will be refused at connect`,
      );
    } else if (!nodeVersionSupported(facts.version)) {
      log(
        `  ${target}: copy is ${facts.version}, below this server's node floor of ${MIN_NODE_VERSION}: ` +
          "machines installing from it will be refused at connect",
      );
    }
  }
  // The one line that says whether anyone can sign in yet. It names the URL
  // only while opening it is the next thing to do — an instance that has an
  // admin must not keep advertising a wizard that will refuse.
  const setup =
    v.setup.database === "missing"
      ? "database not created yet (the server has not booted)"
      : v.setup.hasUsers === null
        ? `database present but unreadable (${v.settings.DATABASE_PATH.value})`
        : v.setup.hasUsers
          ? "admin account exists"
          : `no admin account yet. Open ${v.settings.APP_BASE_URL.value}/setup`;
  log(`setup                = ${setup}`);
  // The file an update would replace, and what is there to roll back to. Named
  // here rather than only in --json because "which binary is this instance"
  // is the first question a failed update raises.
  log(
    v.binary.kind === "compiled"
      ? `installed binary     = ${v.paths.binary} (via ${v.binary.source})`
      : `installed binary     = UNRESOLVED; update cannot run; ${v.binary.reason}`,
  );
  log(
    `database backups     = ${v.backups.count} in ${v.paths.backups}` +
      (v.backups.latest ? `, newest ${v.backups.latest.at}` : ""),
  );
  log(`port ${v.listen.portRaw} on ${v.listen.host}: ${v.listen.listening ? "likely running" : "not listening"}`);
  // Service DEFINITION on disk — not a liveness line (`service status` is the
  // real answer; the port probe above is the closest this view gets).
  if (v.service.definitionPath === null) {
    log("service              = n/a (no per-user service manager on this platform)");
  } else {
    const p = v.service.definitionPath;
    log(`service              = ${v.service.installed ? `definition installed (${p})` : `not installed (${p})`}`);
  }
}

/** The human rendering of {@link ServiceState} — `service status` without `--json`. */
export function serviceStateLines(state: ServiceState): string[] {
  if (state.definitionPath === null) {
    return ["service              = n/a (no per-user service manager on this platform)"];
  }
  if (!state.installed) {
    return [
      `service              = not installed (${state.definitionPath})`,
      "run `subshell-server service install` to background the server",
    ];
  }
  const lines = [
    `service              = definition installed (${state.definitionPath})`,
    `state                = ${state.state}${state.pid !== null ? ` (pid ${state.pid})` : ""}`,
    `starts at login      = ${state.enabled === null ? "unknown" : state.enabled ? "yes" : "no"}`,
  ];
  // Linux only, and only where a systemd definition is what we are describing:
  // launchd has no lingering knob, so the line would be a question with no
  // answer rather than an unknown one. "Starts at login" above is the enabled
  // unit; this is whether a machine nobody logs into ever reaches that login.
  if (state.definitionPath.endsWith(SYSTEMD_UNIT_NAME)) {
    // Shared with the agent's own `service status`, which answers the same
    // question about the same mechanism: two spellings of it is the kind of
    // drift nobody notices and everybody reconciles later.
    lines.push(`survives logout      = ${lingerVerdict(state.linger)}`);
  }
  // The one line an operator cannot get out of systemctl/launchctl, and the
  // one that decides whether stopping or restarting here costs them their work.
  const pane =
    state.paneSafety === "keeps"
      ? "yes"
      : state.paneSafety === "kills"
        ? "NO: this definition predates the fix; reinstall it before stopping or restarting"
        : "unknown: the definition could not be read";
  lines.push(`teardown keeps panes = ${pane}`);
  if (state.detail !== "") lines.push(`detail               = ${state.detail}`);
  return lines;
}
