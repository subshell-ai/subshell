/**
 * Reading a `Probe` into the facts list — a pure function of what `node_probe`
 * and `node_settings` returned, so it is testable without a webview.
 *
 * The shapes it reaches into are the ones declared in `lib/ipc.ts`, which
 * mirror `src-tauri/src/control.rs` and `apps/client`'s `status --json` /
 * `service status --json` bodies. Nothing here decides anything.
 */
import type { AgentChoice, AgentSource, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { isLoopback, type Tone } from "@/lib/steps";

/** One `dt`/`dd` pair. */
export interface Fact {
  key: string;
  value: string;
  tone?: Tone;
}

/** How each rung of the agent ladder reads to someone who has never met the CLI. */
const SOURCE_LABEL: Record<AgentSource, string> = {
  env: "the SUBSHELL_AGENT_BIN environment variable",
  configured: "a binary you chose",
  service: "the installed service definition",
  "local-bin": "~/.local/bin",
  path: "the login PATH",
  "well-known": "a conventional install directory",
};

/**
 * What each `AgentChoice` means for the version fact.
 *
 * Only the two that are news. `install-bundled` and `no-bundled` are already
 * the whole content of the `no-agent` screen, and `up-to-date` is the silent
 * case by definition.
 */
const AGENT_CHOICE_NOTE: Partial<Record<AgentChoice, string>> = {
  "upgrade-available": " — newer than the installed agent",
  "adopt-installed": " — the installed agent is newer, so it is the one in use",
};

/** `daemonAgeMs` as something readable, or null when the field is absent. */
export function fmtAge(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Everything the top card says about this machine. */
export function probeFacts(args: {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  /** The `enroll --json` body from a successful enrollment in THIS session. */
  enrolledNode: EnrolledNodeBody | null;
}): Fact[] {
  const { probe, settings, enrolledNode } = args;
  if (probe === undefined) return [];
  const out: Fact[] = [];
  const st = probe.status;
  const svc = probe.service;

  if (probe.agent) {
    out.push({ key: "agent", value: `${probe.agent.version ?? "version unknown"} — ${probe.agent.argv.join(" ")}` });
    out.push({ key: "found via", value: SOURCE_LABEL[probe.agent.source] ?? probe.agent.source });
  }
  if (probe.bundledVersion) {
    const note = AGENT_CHOICE_NOTE[probe.agentChoice] ?? "";
    out.push({ key: "bundled", value: probe.bundledVersion + note, tone: note ? "warn" : undefined });
  }
  if (settings?.agentBinPath) out.push({ key: "chosen binary", value: settings.agentBinPath });

  if (st?.nodeId) {
    // The name only when THIS session chose it: `status --json` reports
    // nodeId/serverUrl/online and no name, and config.json's name is not among
    // the facts the Rust side hands out — so it is shown when this app just
    // chose it and is silently absent otherwise, rather than being guessed at
    // from the hostname, which is a default and not a fact.
    const named = enrolledNode?.nodeId === st.nodeId && enrolledNode?.name ? ` "${enrolledNode.name}"` : "";
    out.push({ key: "node", value: st.nodeId + named });
  }
  if (st?.serverUrl) {
    out.push({
      key: "control plane",
      value: st.serverUrl,
      tone: isLoopback(st.serverUrl) ? "warn" : undefined,
    });
  }
  // Named because the re-enroll warning refers to it: this 0600 file is the
  // node key's only home, and "discards the current node key" is abstract until
  // the user can see which file is about to be overwritten.
  if (st?.nodeId && probe.paths?.configFile) out.push({ key: "config file", value: probe.paths.configFile });
  if (st?.nodeId) {
    const age = fmtAge(st.daemonAgeMs);
    out.push({
      key: "daemon",
      value: st.online
        ? `online${age ? ` — last heartbeat ${age} ago` : ""}`
        : "offline — no local daemon holds the lock",
      tone: st.online ? "ok" : "warn",
    });
  } else if (st?.reason) {
    // The CLI's own sentence for why it could not read a config — usually "no
    // config at … — enroll this node first", sometimes "config corrupt". The
    // difference matters and is not something to paraphrase.
    out.push({ key: "config", value: st.reason, tone: "warn" });
  }

  if (svc?.installed) {
    out.push({ key: "service", value: svc.definitionPath ?? "unknown" });
    const pid = svc.pid ? ` (pid ${svc.pid})` : "";
    const login = svc.enabled === true ? " — starts at login" : svc.enabled === false ? " — not enabled at login" : "";
    out.push({ key: "manager", value: `${svc.state ?? "unknown"}${pid}${login}` });
    // The one fact neither systemctl nor launchctl will tell them, and the
    // reason a restart can be refused outright.
    if (svc.paneSafety === "kills") {
      out.push({ key: "teardown", value: "kills live subshells — rewrite the service definition", tone: "warn" });
    } else if (svc.paneSafety === "unknown") {
      out.push({ key: "teardown", value: "unknown — the definition could not be read", tone: "warn" });
    }
    if (svc.state === "unknown" && svc.detail) out.push({ key: "service detail", value: svc.detail, tone: "warn" });
  }

  // From the PROBE, not from `status`: tmux is a hard stop on `enroll` — which
  // preflights it BEFORE its network call, precisely so an unenrollable box
  // does not burn a one-time setup key — and on every launch this node accepts.
  out.push({
    key: "tmux",
    value: probe.tmux ?? "NOT FOUND — enroll refuses, and a node without it accepts no launches",
    tone: probe.tmux ? undefined : "bad",
  });

  return out;
}
