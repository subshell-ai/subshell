/**
 * Reading a `Probe` — the status chip and the facts list.
 *
 * Everything here is a pure function of what `node_probe` and `node_settings`
 * returned, so the shapes it reaches into are the ones declared in
 * `src-tauri/src/control.rs` (`Probe`, `NodePaths`, `AgentBinary`) and in
 * `apps/client`'s `status --json` / `service status --json` bodies. Nothing in
 * this file decides anything; `main.js` owns the state and the actions.
 */

import { el, fact } from "./dom.js";

/** How each rung of the agent ladder reads to someone who has never met the CLI. */
const SOURCE_LABEL = Object.assign(Object.create(null), {
  env: "the SUBSHELL_AGENT_BIN environment variable",
  configured: "a binary you chose",
  service: "the installed service definition",
  "local-bin": "~/.local/bin",
  path: "the login PATH",
  "well-known": "a conventional install directory",
});

/**
 * What each `AgentChoice` means for the version fact.
 *
 * Only the two that are news. `install-bundled` and `no-bundled` are already
 * the whole content of the `no-agent` screen, and `up-to-date` is the silent
 * case by definition.
 */
const AGENT_CHOICE_NOTE = Object.assign(Object.create(null), {
  "upgrade-available": " — newer than the installed agent",
  "adopt-installed": " — the installed agent is newer, so it is the one in use",
});

/** `daemonAgeMs` as something readable, or null when the field is absent. */
export function fmtAge(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Whether a control-plane URL points at THIS machine.
 *
 * Mirrors `is_loopback_server` in `src-tauri/src/control.rs`, host for host,
 * so the advisory under the field and the confirmation the Rust side raises
 * agree about what counts. It is never a block: running the control plane and
 * a node on one box is exactly what the desktop pair exists for.
 */
export function isLoopback(raw) {
  let host;
  try {
    host = new URL(String(raw).trim()).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}

/**
 * Whether the installed service definition would take live panes down with it.
 *
 * Fails CLOSED on `unknown`, the way the CLI's own guard does: an unreadable
 * definition is not evidence of safety. A machine with no service installed is
 * not at risk, and is also a machine none of the teardown actions are offered on.
 */
export const paneRisk = (probe) => probe?.service?.installed === true && probe?.service?.paneSafety !== "keeps";

/** Everything the top card says about this machine, rebuilt from scratch each render. */
export function renderFacts({ probe, prefs, enrolledNode }) {
  const dl = el("facts");
  dl.textContent = "";
  if (probe === null) return;
  const st = probe.status;
  const svc = probe.service;

  if (probe.agent) {
    fact(dl, "agent", `${probe.agent.version ?? "version unknown"} — ${probe.agent.argv.join(" ")}`);
    fact(dl, "found via", SOURCE_LABEL[probe.agent.source] ?? probe.agent.source);
  }
  if (probe.bundledVersion) {
    const note = AGENT_CHOICE_NOTE[probe.agentChoice] ?? "";
    fact(dl, "bundled", probe.bundledVersion + note, note ? "warn-text" : null);
  }
  if (prefs?.agentBinPath) fact(dl, "chosen binary", prefs.agentBinPath);

  if (st?.nodeId) {
    // The name only when THIS session chose it — see `enrolledNode` in main.js.
    const named = enrolledNode?.nodeId === st.nodeId && enrolledNode?.name ? ` "${enrolledNode.name}"` : "";
    fact(dl, "node", st.nodeId + named);
  }
  if (st?.serverUrl) {
    fact(dl, "control plane", st.serverUrl, isLoopback(st.serverUrl) ? "warn-text" : null);
  }
  // Named because the re-enroll warning refers to it: this 0600 file is the
  // node key's only home, and "discards the current node key" is abstract
  // until the user can see which file is about to be overwritten.
  if (st?.nodeId && probe.paths?.configFile) fact(dl, "config file", probe.paths.configFile);
  if (st?.nodeId) {
    const age = fmtAge(st.daemonAgeMs);
    fact(
      dl,
      "daemon",
      st.online ? `online${age ? ` — last heartbeat ${age} ago` : ""}` : "offline — no local daemon holds the lock",
      st.online ? "ok-text" : "warn-text",
    );
  } else if (st?.reason) {
    // The CLI's own sentence for why it could not read a config — usually
    // "no config at … — enroll this node first", sometimes "config corrupt".
    // The difference matters and is not something to paraphrase.
    fact(dl, "config", st.reason, "warn-text");
  }

  if (svc?.installed) {
    fact(dl, "service", svc.definitionPath);
    const pid = svc.pid ? ` (pid ${svc.pid})` : "";
    const login = svc.enabled === true ? " — starts at login" : svc.enabled === false ? " — not enabled at login" : "";
    fact(dl, "manager", `${svc.state}${pid}${login}`);
    // The one fact neither systemctl nor launchctl will tell them, and the
    // reason a restart can be refused outright.
    if (svc.paneSafety === "kills") {
      fact(dl, "teardown", "kills live subshells — rewrite the service definition", "warn-text");
    } else if (svc.paneSafety === "unknown") {
      fact(dl, "teardown", "unknown — the definition could not be read", "warn-text");
    }
    if (svc.state === "unknown" && svc.detail) fact(dl, "service detail", svc.detail, "warn-text");
  }

  // From the PROBE, not from `status`: tmux is a hard stop on `enroll` — which
  // preflights it BEFORE its network call, precisely so an unenrollable box
  // does not burn a one-time setup key — and on every launch this node accepts.
  fact(
    dl,
    "tmux",
    probe.tmux ?? "NOT FOUND — enroll refuses, and a node without it accepts no launches",
    probe.tmux ? null : "bad-text",
  );
}

/** One word for where this machine stands, keyed by the same step enum. */
export function renderChip({ probe, busy }) {
  const step = probe?.step ?? null;
  const tone =
    step === "online" ? "ok" : step === "offline" ? "bad" : step === "stopped" || step === "no-service" ? "warn" : "";
  const label =
    step === "online"
      ? "Online"
      : step === "offline"
        ? "Offline"
        : step === "stopped"
          ? "Service stopped"
          : step === "no-service"
            ? "Not running in the background"
            : step === "not-enrolled"
              ? "Not enrolled"
              : step === "no-agent"
                ? "No agent"
                : "Unknown";
  el("dot").className = `dot ${tone}`.trim();
  el("state").textContent = busy ? "Working…" : probe === null ? "Checking…" : label;
  el("refresh").disabled = busy;
}
