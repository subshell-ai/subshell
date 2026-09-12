/**
 * Overview's Details list: every fact about this machine that the hero does
 * not already state, and nothing the hero does.
 *
 * The list used to open with `server cli` and carry `control plane URL` in the
 * middle — the two answers a person actually came for, in the same 14px as the
 * tmux path. Both moved to the hero (`hero.ts`), and what is left here is the
 * diagnostic half: where things are, what the service manager says, and the
 * three rows that only ever appear when something is wrong.
 */

import type { OpenTarget } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { type ConsoleHost, el, state } from "./state";

/** A small action riding on a facts row. It names an INTENT; paths stay in Rust. */
interface FactAction {
  label: string;
  run: () => void;
}

/**
 * One facts row, optionally carrying an action — a path to reveal in the
 * file manager.
 *
 * The action names an intent, never a path: the Rust side re-reads the path
 * from its own probe, so a row can only ever reveal the fact it is showing.
 * `sub` is a second, quieter line under the value, for a fact that needs a
 * sentence rather than a longer string (the resolution rung).
 */
function fact(
  dl: HTMLElement,
  key: string,
  value: string,
  cls: string | null,
  action: FactAction | null = null,
  sub: string | null = null,
): void {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  const line = document.createElement("span");
  line.textContent = value;
  if (cls) line.className = cls;
  dd.append(line);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    // A `.linkish` rather than a bordered button: four Reveal boxes down the
    // right of a fact list read as the busiest thing on the page, and every
    // one of them is a convenience.
    b.className = "linkish";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    dd.append(b);
  }
  if (sub) {
    const note = document.createElement("span");
    note.className = "fact-sub";
    note.textContent = sub;
    dd.append(note);
  }
  dl.append(dt, dd);
}

/**
 * Which rung of the resolution ladder found the server, in words.
 *
 * `probe.server.source` is the wire form of `ServerSource` — `local-bin`,
 * `well-known` — which is right for a protocol and unreadable in a fact list
 * a first-time user is looking at. Falls back to the raw value, so a rung
 * added to a newer Rust half still renders something rather than nothing;
 * the map is `Partial` so that fallback is the type-checked answer, not a
 * type-system blind spot.
 */
// `Object.create(null)` like STEPS: a rung named e.g. `constructor` would
// otherwise find `Object.prototype`'s member instead of falling back to the
// raw value the line above promises.
const SOURCE_LABELS: Partial<Record<ipc.ServerSource, string>> = Object.assign(Object.create(null), {
  env: "named by SUBSHELL_SERVER_BIN",
  configured: "you chose this path",
  service: "named by the installed service",
  "local-bin": "installed by this app",
  path: "on your login PATH",
  "well-known": "in a standard install directory",
});

export function renderFacts(host: ConsoleHost): void {
  /** Reveal one of the CLI's own paths. Success is visible in the file manager, so only the failure needs surfacing. */
  const revealAction = (target: OpenTarget, label = "Reveal"): FactAction => ({
    label,
    run: () => {
      ipc.openPath(target).catch((err: unknown) => host.fail(err));
    },
  });

  const dl = el("facts");
  dl.textContent = "";
  const probe = state.probe;
  const svc = probe?.service ?? null;
  const st = probe?.status ?? null;
  // The version row is the hero's now. What stays is WHERE it came from —
  // the path, with the rung as its own quiet line rather than a parenthesis.
  if (probe?.server) {
    fact(
      dl,
      "Server binary",
      probe.server.argv.join(" "),
      null,
      revealAction("server-dir"),
      SOURCE_LABELS[probe.server.source] ?? probe.server.source,
    );
  }
  // There used to be a second version row here, for the copy of the server
  // this app carries inside itself. It went through three labels and none of
  // them helped, because the problem was not the wording: the row exists to
  // COMPARE two numbers, and the comparison is only ever actionable one way
  // — an update is available — where the "Update server to X" button already
  // says so, with the version in the label. Equal numbers told the reader
  // nothing they could act on, while asking them to understand that a desktop
  // app ships a copy of a CLI. That is our implementation detail, not theirs.
  //
  // The one case worth a row is the reverse, because otherwise the app looks
  // broken: a NEWER server is already installed, so this app is deliberately
  // not using the copy it shipped with, and offers no update. Said as a
  // sentence rather than as a number the reader has to interpret.
  if (probe?.serverChoice === "adopt-installed" && probe?.bundledVersion) {
    fact(dl, "This app's copy", `${probe.bundledVersion}, older than the server above, so it is not used`, "warn-text");
  }
  // The Reveal on a missing config.env would only answer "does not exist
  // yet", so the row earns its button once the file does.
  if (st?.configEnv) {
    fact(
      dl,
      "config.env",
      st.configEnv.path,
      null,
      st.configEnv.exists ? revealAction("config-env") : null,
      st.configEnv.exists ? null : "missing",
    );
  }
  // From the PROBE, not from `status` — tmux is a hard stop on `init` and
  // `service install`, and on a clean machine there is no server to ask yet.
  if (probe) {
    // Just the fact: the amber warning on Overview says what it blocks and
    // offers the command, so an instruction here is the third telling.
    fact(dl, "tmux", probe.tmux ?? "NOT FOUND", probe.tmux ? null : "bad-text");
  }
  // An unresolved MCP entrypoint means every subshell create 500s. It is the
  // one status fact that predicts a failure the user would otherwise meet
  // later, in a completely different part of the app.
  if (st && !st.mcp) {
    fact(dl, "MCP entrypoint", `UNRESOLVED: subshell create will fail. ${st.mcpError ?? ""}`.trim(), "bad-text");
  }
  // A server can be listening without being service-managed (someone started
  // it in a terminal). Without this the console insists it is "stopped" while
  // the app plainly works.
  if (st?.listen?.listening && svc?.state !== "running") {
    fact(dl, "Port", `something is already listening on ${st.listen.portRaw}`, "warn-text");
  }
  if (svc?.installed) {
    fact(dl, "Service", svc.definitionPath ?? "", null, revealAction("service-definition"));
    // `detail` carries what the manager said verbatim — `launchd: spawn
    // scheduled` is the crash-throttle state, and "stopped" alone hides it.
    fact(
      dl,
      "Manager",
      (svc.state ?? "unknown") + (svc.pid ? ` (pid ${svc.pid})` : "") + (svc.detail ? `, ${svc.detail}` : ""),
      svc.state === "unknown" ? "bad-text" : null,
    );
    // The one fact neither systemctl nor launchctl will tell them.
    if (svc.paneSafety === "kills") {
      fact(dl, "Teardown", "kills live panes; reinstall the service definition", "warn-text");
    } else if (svc.paneSafety === "unknown") {
      fact(dl, "Teardown", "unknown (the definition could not be read)", "warn-text");
    }
  }
  // Where the server's own output goes. macOS: a file the plist names,
  // revealed in the file manager. Linux: the journal, and the row says the
  // command. OUTSIDE the installed block on purpose: the CLI answers `logPath`
  // even when nothing is installed, because logs written by a since-stopped
  // or uninstalled server are still sitting there — "open the log" is exactly
  // the question asked when the service is down. An OLD server reports
  // neither shape — no field at all — and gets no row rather than a wrong one.
  if (svc && typeof svc.logPath === "string") {
    fact(dl, "Logs", svc.logPath, null, revealAction("logs"));
  } else if (svc && svc.logPath === null) {
    fact(dl, "Logs", "the systemd journal: journalctl --user -u subshell-server.service -f", null);
  }
}
