/**
 * Reading a `Probe` into the facts list — a pure function of what `node_probe`
 * and `node_settings` returned, so it is testable without a webview.
 *
 * The shapes it reaches into are the ones declared in `lib/ipc.ts`, which
 * mirror `src-tauri/src/control.rs` and `apps/node/agent`'s `status --json` /
 * `service status --json` bodies. Nothing here decides anything.
 */
import type { EnrolledNodeBody, NodeChoice, NodeSettings, NodeSource, Probe } from "@/lib/ipc";
import type { Tone } from "@/lib/steps";

/** One `dt`/`dd` pair. */
export interface Fact {
  key: string;
  value: string;
  tone?: Tone;
}

/** How each rung of the node-binary ladder reads to someone who has never met the CLI. */
const SOURCE_LABEL: Record<NodeSource, string> = {
  env: "the SUBSHELL_NODE_BIN environment variable",
  configured: "a binary you chose",
  service: "the installed service definition",
  "local-bin": "~/.local/bin",
  path: "the login PATH",
  "well-known": "a conventional install directory",
};

/**
 * What each `NodeChoice` means for the version fact.
 *
 * Only the two that are news. `install-bundled` and `no-bundled` are already
 * the whole content of the `no-node` screen, and `up-to-date` is the silent
 * case by definition.
 */
const NODE_CHOICE_NOTE: Partial<Record<NodeChoice, string>> = {
  "upgrade-available": " (newer than the installed node CLI)",
  "adopt-installed": " (the installed node CLI is newer, so it is the one in use)",
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

/**
 * Everything the top card says about this machine. The bundled and tmux rows
 * are part of the list again (operator ruling 2026-09-22, screenshot 60: the
 * facts render on the STATUS screen ALONE, so the screenshot-52 scoping that
 * kept them on Service is superseded — one list, one panel).
 */
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

  if (probe.nodeBinary) {
    out.push({
      key: "node binary",
      value: `${probe.nodeBinary.version ?? "version unknown"} (${probe.nodeBinary.argv.join(" ")})`,
    });
    out.push({ key: "found via", value: SOURCE_LABEL[probe.nodeBinary.source] ?? probe.nodeBinary.source });
  }
  if (probe.bundledVersion) {
    const note = NODE_CHOICE_NOTE[probe.nodeChoice] ?? "";
    out.push({ key: "bundled", value: probe.bundledVersion + note, tone: note ? "warn" : undefined });
  }
  if (settings?.nodeBinPath) out.push({ key: "chosen binary", value: settings.nodeBinPath });

  if (st?.nodeId) {
    // The name only when THIS session chose it: `status --json` reports
    // nodeId/serverUrl/online and no name, and config.json's name is not among
    // the facts the Rust side hands out — so it is shown when this app just
    // chose it and is silently absent otherwise, rather than being guessed at
    // from the hostname, which is a default and not a fact.
    const named = enrolledNode?.nodeId === st.nodeId && enrolledNode?.name ? ` "${enrolledNode.name}"` : "";
    out.push({ key: "node", value: st.nodeId + named });
  }
  // The node's own control-plane address is deliberately NOT a fact here.
  // `components/node-plane-card.tsx` owns it, because it is the one address on
  // this page that can be CHANGED — and an address shown in two cards is two
  // places to keep in step. The loopback warning moved with it.
  // Named because the re-enroll warning refers to it: this 0600 file is the
  // node key's only home, and "discards the current node key" is abstract until
  // the user can see which file is about to be overwritten.
  if (st?.nodeId && probe.paths?.configFile) out.push({ key: "config file", value: probe.paths.configFile });
  if (st?.nodeId) {
    const age = fmtAge(st.daemonAgeMs);
    out.push({
      key: "daemon",
      value: st.online
        ? `online${age ? ` (last heartbeat ${age} ago)` : ""}`
        : "offline: no local daemon holds the lock",
      tone: st.online ? "ok" : "warn",
    });
  } else if (st?.reason) {
    // PLAIN LANGUAGE, not the CLI's words (operator ruling 2026-09-22,
    // screenshot 60): the enroll-command hint belongs to the CLI and the
    // enroll flow, not to a facts row, and a raw refusal reads as an error
    // the reader cannot act on. Two states, two sentences: the reason that
    // points at enrolling becomes the pointer to the Service section; any
    // other unreadable-config reason becomes the one sentence that is true
    // of all of them. The CLI's own words still render VERBATIM where they
    // belong — as an action's failure output on the screen that owns the
    // action.
    const notEnrolled = /enroll/i.test(st.reason);
    out.push({
      key: "config",
      value: notEnrolled ? "Not enrolled. Go to Service to enroll." : "The node's configuration could not be read.",
      tone: "warn",
    });
  }

  if (svc?.installed) {
    out.push({ key: "service", value: svc.definitionPath ?? "unknown" });
    const pid = svc.pid ? ` (pid ${svc.pid})` : "";
    const login = svc.enabled === true ? " (starts at login)" : svc.enabled === false ? " (not enabled at login)" : "";
    // `detail` is what the MANAGER said, verbatim — "launchd: spawn scheduled"
    // is the crash-throttle wait, and "stopped" alone hides the fact that the
    // job keeps trying and failing. An unknown state is red: a manager that
    // would not answer is not the same fact as a service that is stopped.
    const detail = svc.detail ? ` (${svc.detail})` : "";
    out.push({
      key: "manager",
      value: `${svc.state ?? "unknown"}${pid}${login}${detail}`,
      tone: svc.state === "unknown" ? "bad" : undefined,
    });
    // The one fact neither systemctl nor launchctl will tell them, and the
    // reason a restart can be refused outright.
    if (svc.paneSafety === "kills") {
      out.push({ key: "teardown", value: "kills live subshells: rewrite the service definition", tone: "warn" });
    } else if (svc.paneSafety === "unknown") {
      out.push({ key: "teardown", value: "unknown: the definition could not be read", tone: "warn" });
    }
    // Where the node's own output goes. macOS: the file the plist names, and
    // the "Open the node log" button reveals it. Linux: the journal, and the
    // row says so — the hint sentence is the Rust side's, not a copy here.
    if (probe.paths?.nodeLog) out.push({ key: "logs", value: probe.paths.nodeLog });
    else if (probe.paths?.nodeLogHint) out.push({ key: "logs", value: probe.paths.nodeLogHint });
  }

  // From the PROBE, not from `status`: tmux is a hard stop on `enroll` — which
  // preflights it BEFORE its network call, precisely so an unenrollable box
  // does not burn a one-time setup key — and on every launch this node accepts.
  out.push({
    key: "tmux",
    value: probe.tmux ?? "NOT FOUND: enroll refuses, and a node without it accepts no launches",
    tone: probe.tmux ? undefined : "bad",
  });

  return out;
}
