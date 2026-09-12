/**
 * What the recovery screen SAYS, pure (spec 2026-09-12 § 5.3).
 *
 * The subtitle under each step's title, and the pre-boot facts behind Show
 * Details. Both were DOM in the console — `console/steps.ts`'s step table and
 * `console/facts.ts`'s Details list — which is why neither was ever covered:
 * the strings only existed inside a render that needs a webview. They are
 * data here, so the screen's content is testable and the page stays a
 * rendering of it.
 *
 * Nothing here re-derives a path. Every value is quoted from the CLI's own
 * `status --json` / `service status --json`, and a fact the installed server
 * does not report gets no row rather than a guessed one.
 */
import type { OpenTarget, Probe, ProbeStep, ServerSource } from "./ipc";

/**
 * One line under the recovery title: what this step MEANS, in the words the
 * console's step table used, because they were written for exactly this
 * moment and two surfaces phrasing one state differently is the drift this
 * file exists to prevent.
 *
 * `setup` and `ready` return nothing: on those two the title is already the
 * whole sentence, and a subtitle repeating it is the same thing said twice in
 * two type sizes.
 */
export function recoverySubtitle(step: ProbeStep): string {
  switch (step) {
    case "no-server":
      return "No subshell-server was found, and this build does not ship one.";
    case "unreachable":
      return "A subshell-server was found, but it did not answer. Nothing has been changed.";
    case "init":
      return "The server has a binary but no configuration yet.";
    case "install-service":
      return "It is configured, but not installed as a background service.";
    case "start":
      return "The background service is installed but not running.";
    default:
      return "";
  }
}

/**
 * One row of the Show Details disclosure.
 *
 * `tone` is a rendering hint the model owns because the DECISION is a fact
 * about the machine (a missing tmux is bad, a pane-killing teardown is a
 * warning), not a styling choice the screen should be making. `reveal` names
 * an INTENT from a closed set — the Rust side re-reads the path from its own
 * fresh probe, so a row can only ever reveal the fact it is showing.
 */
export interface RecoveryFact {
  label: string;
  value: string;
  tone?: "bad" | "warn";
  /** A quieter second line under the value, for a fact that needs a sentence. */
  sub?: string;
  reveal?: OpenTarget;
}

/**
 * Which rung of the resolution ladder found the server, in words.
 *
 * `server.source` is the wire form of `ServerSource` — `local-bin`,
 * `well-known` — which is right for a protocol and unreadable to someone
 * repairing their install. Falls back to the raw value, so a rung added to a
 * newer Rust half still renders something; the map is `Partial` so that
 * fallback is the type-checked answer rather than a blind spot.
 *
 * `Object.create(null)`: a rung named `constructor` would otherwise resolve
 * to `Object.prototype`'s member instead of falling through.
 */
const SOURCE_LABELS: Partial<Record<ServerSource, string>> = Object.assign(Object.create(null), {
  env: "named by SUBSHELL_SERVER_BIN",
  configured: "you chose this path",
  service: "named by the installed service",
  "local-bin": "installed by this app",
  path: "on your login PATH",
  "well-known": "in a standard install directory",
});

/**
 * Every fact worth having when the server will not come up: where the binary
 * is and which rung found it, where the configuration is, what the service
 * manager says in its own words, and where the logs are.
 *
 * The rows that only appear when something is wrong are the point — an
 * unresolved MCP entrypoint predicts a failure the user would otherwise meet
 * much later and somewhere else, and a pane-killing teardown is the one fact
 * neither `systemctl` nor `launchctl` will tell them.
 */
export function recoveryFacts(probe: Probe | null): RecoveryFact[] {
  if (probe === null) return [];
  const out: RecoveryFact[] = [];
  const svc = probe.service ?? null;
  const st = probe.status ?? null;

  if (probe.server) {
    out.push({
      label: "Server binary",
      value: probe.server.argv.join(" "),
      sub: SOURCE_LABELS[probe.server.source] ?? probe.server.source,
      reveal: "server-dir",
    });
  }
  // The reverse of an available update, and the only version comparison worth
  // a row: a NEWER server is already installed, so this app is deliberately
  // not using the copy it ships and offers no update. Said as a sentence,
  // because a bare number asks the reader to understand that a desktop app
  // carries a copy of a CLI — our implementation detail, not theirs.
  if (probe.serverChoice === "adopt-installed" && probe.bundledVersion) {
    out.push({
      label: "This app's copy",
      value: `${probe.bundledVersion}, older than the server above, so it is not used`,
      tone: "warn",
    });
  }
  // A Reveal on a config.env that does not exist could only answer "not yet",
  // so the row earns its button once the file does.
  if (st?.configEnv) {
    out.push({
      label: "Configuration",
      value: st.configEnv.path,
      sub: st.configEnv.exists ? undefined : "missing",
      reveal: st.configEnv.exists ? "config-env" : undefined,
    });
  }
  // From the PROBE, not from `status`: tmux is a hard stop on `init` and
  // `service install`, and on a clean machine there is no server to ask.
  out.push({ label: "tmux", value: probe.tmux ?? "NOT FOUND", tone: probe.tmux ? undefined : "bad" });
  if (st && !st.mcp) {
    out.push({
      label: "MCP entrypoint",
      value: `UNRESOLVED: subshell create will fail. ${st.mcpError ?? ""}`.trim(),
      tone: "bad",
    });
  }
  // A server can be listening without being service-managed (someone started
  // it in a terminal). Without this the screen insists it is stopped while
  // the app plainly works.
  if (st?.listen?.listening && svc?.state !== "running") {
    out.push({
      label: "Port",
      value: `something is already listening on ${st.listen.portRaw ?? ""}`.trim(),
      tone: "warn",
    });
  }
  if (svc?.installed) {
    out.push({ label: "Service", value: svc.definitionPath ?? "", reveal: "service-definition" });
    // `detail` is what the manager said verbatim — `launchd: spawn scheduled`
    // is the crash-throttle wait, and "stopped" alone hides it.
    out.push({
      label: "Manager",
      value: (svc.state ?? "unknown") + (svc.pid ? ` (pid ${svc.pid})` : "") + (svc.detail ? `, ${svc.detail}` : ""),
      tone: svc.state === "unknown" ? "bad" : undefined,
    });
    if (svc.paneSafety === "kills") {
      out.push({ label: "Teardown", value: "kills live panes; reinstall the service definition", tone: "warn" });
    } else if (svc.paneSafety === "unknown") {
      out.push({ label: "Teardown", value: "unknown (the definition could not be read)", tone: "warn" });
    }
  }
  // Where the server's own output goes. OUTSIDE the installed block on
  // purpose: the CLI answers `logPath` even with nothing installed, because
  // logs written by a since-stopped server are still sitting there — and "let
  // me read the log" is exactly the question asked when the service is down.
  // An OLD server reports neither shape and gets no row rather than a wrong one.
  if (svc && typeof svc.logPath === "string") {
    out.push({ label: "Logs", value: svc.logPath, reveal: "logs" });
  } else if (svc && svc.logPath === null) {
    out.push({ label: "Logs", value: "the systemd journal: journalctl --user -u subshell-server.service -f" });
  }
  return out;
}

/**
 * Whether a restart or a replacement here closes live subshells.
 *
 * `unknown` counts as unsafe: the definition could not be read, and the
 * warning that turns out to have been unnecessary costs a sentence, where the
 * one that was needed and absent costs someone's running sessions.
 */
export function paneRisk(probe: Probe | null): boolean {
  const safety = probe?.service?.paneSafety;
  return probe?.service?.installed === true && safety !== "keeps";
}
