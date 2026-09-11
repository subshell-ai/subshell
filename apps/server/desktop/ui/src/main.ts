/**
 * The server console — the one surface that must render with the server DOWN,
 * and the only one allowed to drive the `subshell-server` CLI.
 *
 * TypeScript on Vite with Tailwind (2026-09-10). The page stayed plain JS for
 * as long as its argument was "no build step between the user and the thing
 * that fixes their broken install"; the build moved INSIDE that promise rather
 * than in front of it — `tauri dev` and `tauri build` run `vite build` as
 * their own before-hook, so there is no way to launch or bundle the app that
 * skips it, and the CSP-clean output rules (inline preload polyfill off, no
 * inlined assets) live in `vite.config.ts` against the policy in
 * `tauri.conf.json`. It is still a module rather than an inline script
 * because `script-src 'self'` applies, and the pure decisions still live in
 * `lib/` where they can be tested without a webview.
 *
 * The CLI owns every operator-facing message — the `loginctl enable-linger`
 * hint, the tmux refusal, the live-pane warning — so its stdout and stderr are
 * shown VERBATIM and never re-worded here. Two surfaces that phrase the same
 * refusal differently are two surfaces that drift.
 */
import { ask as askDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  explicitFields,
  type FormValues,
  fieldProblems,
} from "./lib/config-form";
import { type InstallPlan, tmuxInstallPlan } from "./lib/installers";
import type { ActionResult, OpenTarget, Probe, ProbeStep } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import "./styles.css";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the console page is missing #${id}`);
  return node;
};

/** A rejected command's words, for the problem line. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Latest probe, or null before the first one lands. */
let probe: Probe | null = null;
/** True while a command is in flight; every button is disabled meanwhile. */
let busy = false;
/** Why the last action or probe failed, in the CLI's words. */
let problem = "";
/**
 * The init form's values, held OUTSIDE the DOM.
 *
 * The form is rebuilt whenever the step changes, and every guarded action ends
 * with a re-probe — so reading `input.value` at click time raced the rebuild
 * and submitted whatever the fresh inputs happened to hold. The typed value is
 * the state; the input is a view of it.
 */
let form: FormValues = effectiveForm(undefined);
/**
 * Which fields to send: chosen before this form opened, or typed into since.
 *
 * The inputs are PREFILLED with the effective configuration, so blankness no
 * longer distinguishes "nobody chose this" from "someone chose empty". This
 * does. A field not in here is sent empty, which is how the CLI is told to
 * keep deriving it, and a field already in config.env starts in here so that
 * saving without touching it cannot wipe it: see `explicitFields`.
 */
let explicit: ExplicitMap = {};
/** Which step the action area currently shows, so focus survives a re-render. */
let renderedStep: string | null = null;

/** Show a result's own words. `ok:false` is styled as a failure, not as output. */
function show(result: ActionResult | null): void {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  const out = el("output");
  out.textContent = parts.join("\n\n");
  out.classList.toggle("output-bad", result?.ok === false);
  // A result is what the user just asked for, so it takes the foreground.
  // `show(null)` at the start of every action clears the old text but must
  // NOT steal the tab, or the pane would flick to an empty box and back.
  if (parts.length > 0) showPane("output");
}

/** Which pane is in front. The log unless a command has just spoken. */
let pane: "log" | "output" = "log";

/**
 * Bring one pane forward.
 *
 * Two tabs over one region rather than two stacked panes, because the window
 * is 620px by default and a second always-on block pushed the step actions off
 * the bottom on a machine with several facts to report.
 */
function showPane(next: "log" | "output"): void {
  pane = next;
  for (const id of ["log", "output"]) {
    el(id).hidden = id !== pane;
    const tab = el(`tab-${id}`);
    tab.setAttribute("aria-selected", String(id === pane));
  }
  el("pane-source").textContent = pane === "log" ? logSource : "";
}

/** Where the log came from, captioned beside the tabs. */
let logSource = "";

/**
 * Pull the log tail and render it.
 *
 * Rides the same tick as the probe (see `poll`), so the pane follows the
 * server without a mechanism of its own. Two behaviours worth keeping:
 *
 * - It STICKS to the bottom only when it is already there. Re-tailing while
 *   someone has scrolled up to read would yank the view out from under them.
 * - A note (no entries yet, no service installed) is rendered as the pane's
 *   text rather than as an error, because during setup it is the ordinary
 *   answer and an error banner would teach the user to ignore the pane.
 */
async function refreshLog(): Promise<void> {
  const tail = await ipc.logs();
  const box = el("log");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = tail.text || tail.note || "";
  box.classList.toggle("muted-text", !tail.text);
  logSource = tail.text || tail.note ? tail.source : "";
  if (pane === "log") el("pane-source").textContent = logSource;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** A small action riding on a facts row. It names an INTENT; paths stay in Rust. */
interface FactAction {
  label: string;
  run: () => void;
}

/**
 * One facts row, optionally carrying an action — a path to reveal in the
 * file manager, the control plane to open in a browser.
 *
 * The action names an intent, never a path: the Rust side re-reads the path
 * from its own probe, so a row can only ever reveal the fact it is showing.
 */
function fact(dl: HTMLElement, key: string, value: string, cls: string | null, action: FactAction | null = null): void {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    dd.append(b);
  }
  dl.append(dt, dd);
}

/** Reveal one of the CLI's own paths. Success is visible in the file manager, so only the failure needs surfacing. */
function reveal(target: OpenTarget): void {
  ipc.openPath(target).catch((err: unknown) => {
    problem = errText(err);
    render();
  });
}
const revealAction = (target: OpenTarget, label = "Reveal"): FactAction => ({ label, run: () => reveal(target) });

/** Open the control plane's URL in the SYSTEM browser — the address row shows, not a URL from this side. */
function openControlPlane(): void {
  ipc.openControlPlane().catch((err: unknown) => {
    problem = errText(err);
    render();
  });
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

function renderFacts(): void {
  const dl = el("facts");
  dl.textContent = "";
  const svc = probe?.service ?? null;
  const st = probe?.status ?? null;
  if (probe?.server) {
    // Two rows, each holding what its label promises: WHAT it is, then WHERE
    // it came from. "server version" used to carry the path as well, and the
    // rung sat in a third row answering the same question the path did.
    fact(dl, "server cli", probe.server.version ?? "unknown version", null);
    const how = SOURCE_LABELS[probe.server.source] ?? probe.server.source;
    fact(dl, "found at", `${probe.server.argv.join(" ")} (${how})`, null, revealAction("server-dir"));
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
    fact(
      dl,
      "this app's own copy",
      `${probe.bundledVersion}, older than the server above, so it is not used`,
      "warn-text",
    );
  }
  // The Reveal on a missing config.env would only answer "does not exist
  // yet", so the row earns its button once the file does.
  if (st?.configEnv) {
    fact(
      dl,
      "config.env",
      `${st.configEnv.path} (${st.configEnv.exists ? "present" : "missing"})`,
      null,
      st.configEnv.exists ? revealAction("config-env") : null,
    );
  }
  // The name says what it is — the address OTHER machines use — and it opens
  // in the system browser, where a LAN host or TLS cert is the user's own
  // browser problem, not something to point the privileged window at.
  if (st?.settings?.APP_BASE_URL) {
    fact(dl, "control plane URL", st.settings.APP_BASE_URL.value ?? "", null, {
      label: "Open in browser",
      run: openControlPlane,
    });
  }
  // From the PROBE, not from `status` — tmux is a hard stop on `init` and
  // `service install`, and on a clean machine there is no server to ask yet.
  if (probe) {
    // Just the fact: the amber warning directly below says what it blocks
    // and offers the command, so an instruction here is the third telling.
    fact(dl, "tmux", probe.tmux ?? "NOT FOUND", probe.tmux ? null : "bad-text");
  }
  // An unresolved MCP entrypoint means every subshell create 500s. It is the
  // one status fact that predicts a failure the user would otherwise meet
  // later, in a completely different part of the app.
  if (st && !st.mcp) {
    fact(dl, "mcp entrypoint", `UNRESOLVED: subshell create will fail. ${st.mcpError ?? ""}`.trim(), "bad-text");
  }
  // A server can be listening without being service-managed (someone started
  // it in a terminal). Without this the console insists it is "stopped" while
  // the app plainly works.
  if (st?.listen?.listening && svc?.state !== "running") {
    fact(dl, "port", `something is already listening on ${st.listen.portRaw}`, "warn-text");
  }
  if (svc?.installed) {
    fact(dl, "service", svc.definitionPath ?? "", null, revealAction("service-definition"));
    // `detail` carries what the manager said verbatim — `launchd: spawn
    // scheduled` is the crash-throttle state, and "stopped" alone hides it.
    fact(
      dl,
      "manager",
      (svc.state ?? "unknown") + (svc.pid ? ` (pid ${svc.pid})` : "") + (svc.detail ? `, ${svc.detail}` : ""),
      svc.state === "unknown" ? "bad-text" : null,
    );
    // The one fact neither systemctl nor launchctl will tell them.
    if (svc.paneSafety === "kills") {
      fact(dl, "teardown", "kills live panes; reinstall the service definition", "warn-text");
    } else if (svc.paneSafety === "unknown") {
      fact(dl, "teardown", "unknown (the definition could not be read)", "warn-text");
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
    fact(dl, "logs", svc.logPath, null, revealAction("logs"));
  } else if (svc && svc.logPath === null) {
    fact(dl, "logs", "the systemd journal: journalctl --user -u subshell-server.service -f", null);
  }
}

/** One entry of the actions row: label, handler, and the two rendering flags. */
type StepAction = [label: string, handler: () => unknown, primary?: boolean, needsTmux?: boolean];

/** One entry of the STEPS table. */
interface Step {
  body: string;
  hint?: string;
  /** Whether the init/configure form is part of this step. */
  form?: boolean;
  actions: () => StepAction[];
}

/**
 * One entry per `ProbeStep` the Rust side can emit.
 *
 * `Object.create(null)` so a step named `constructor` or `toString` cannot
 * resolve to something inherited and crash the render loop.
 */
const STEPS: Partial<Record<ProbeStep | "configure", Step>> = Object.assign(Object.create(null), {
  "no-server": {
    body: "No subshell-server was found, and this build does not ship one.",
    hint: "Point the app at a server binary you already have.",
    actions: () => [["Choose subshell-server…", pickBinary, true]],
  },
  setup: {
    body: "Set up Subshell on this machine.",
    hint:
      "Installs the bundled server to ~/.local/bin, writes ~/.config/subshell-server/config.env (port 3080, all " +
      "interfaces), registers it to start at login, starts it, and opens the dashboard. Nothing is downloaded.",
    actions: () => [
      // tmux-gated like every step that advances setup: the chain ends in
      // `init` and `service install`, both of which refuse without tmux (every
      // local pane launches through it), so an enabled button here would just
      // walk the press into that wall.
      ["Set up and start", doSetup, true, true],
      // An agent is worth having before the dashboard, but the button is
      // secondary (setup never waits on it) and tmux-gated like the chain:
      // with no tmux there is no pane to run an agent in yet.
      ["Also install Claude Code", () => doInstallAgent("claude-code"), false, true],
      // No "Change addresses…" here: this screen exists exactly where no
      // server resolves, and the form's save IS `subshell-server init` — it
      // could only answer "no subshell-server found", and the next press
      // would then overwrite the edit without a word. The hint discloses the
      // defaults the press writes; the form is one button deep from every
      // screen where saving can work. (Pinned by test.)
      ["Choose an existing server…", pickBinary],
    ],
  },
  unreachable: {
    body: "A subshell-server was found, but it did not answer.",
    hint: "Nothing has been changed. Retry, or choose a different binary; this app will not rewrite a configuration it cannot read. If the answer you expect is a different port or address, edit it here.",
    actions: () => [
      ["Retry", retry, true],
      ["Choose a different one…", pickBinary],
      ["Change addresses…", showConfigure],
    ],
  },
  init: {
    body: "The server has no config.env yet. Choose the port and the addresses it will answer to.",
    // Forward tense: this sits under the form, BEFORE the button is pressed.
    // "Written to …" read as a report of a write that had already happened.
    // And the secret is generated exactly ONCE, since a value already in the
    // file wins and an environment one is adopted, so "a fresh auth secret"
    // was wrong on both of those paths (`commands/init.ts`).
    hint:
      "Creates ~/.config/subshell-server/config.env (0600), and an auth secret if there is not one already, then " +
      "installs the background service and starts it.",
    form: true,
    actions: () => [["Save and start", doInit, true, true]],
  },
  "install-service": {
    body: "Configured, but not installed as a background service.",
    hint: "A systemd user unit on Linux, a launchd agent on macOS. Installing also starts it, and it starts at login from then on.",
    actions: () => [
      ["Install and start as a service", service("install", true), true, true],
      ["Change addresses…", showConfigure],
    ],
  },
  start: {
    body: "The service is installed but not running.",
    actions: () => [
      ["Start", service("start", true), true, true],
      ["Uninstall service", service("uninstall")],
      ["Change addresses…", showConfigure],
    ],
  },
  ready: {
    body: "The server is running.",
    actions: () => [
      // The tray's item for this same window says "Open Dashboard".
      ["Open Dashboard", openMain, true],
      // Still reachable after setup, for the user who sets the server up
      // first and thinks about agents second.
      ["Install Claude Code", () => doInstallAgent("claude-code"), false, true],
      ["Restart", doRestart, false, true],
      ["Stop", doStop],
      ["Change addresses…", showConfigure],
    ],
  },
  // Reached from any configured step, not from the probe: this is an edit of
  // a configuration, so it is something the user asks for rather than
  // something the machine's state implies. Reachable from `start`,
  // `install-service` and `unreachable` too — a wrong port is exactly why
  // those steps stick, and a step that cannot say "change it" strands the
  // user in the one state they need to leave.
  configure: {
    body: "Change the addresses this server listens on and answers to.",
    hint:
      "Sign-in fails with “Invalid origin” from any address the server does not know about, so list every " +
      "one you browse from. Saving rewrites config.env and restarts the server, which reads these once at boot.",
    form: true,
    actions: () => [
      ["Save and restart", doConfigure, true, true],
      ["Cancel", cancelConfigure],
    ],
  },
} satisfies Partial<Record<ProbeStep | "configure", Step>>);

/**
 * `configure` is a step the USER chooses, so it cannot come from the probe —
 * which reports what the machine implies. Held beside `probe.next` and cleared
 * whenever the flow moves on.
 */
let override: "configure" | null = null;

/** What to show before the first probe lands, or for a step this build predates. */
function fallbackStep(): Step {
  return probe === null
    ? { body: "Checking this machine…", actions: () => [] }
    : {
        body: `This app does not know what to do about "${probe.next}".`,
        hint: "That usually means the app is older than the server it is managing.",
        actions: () => [["Retry", retry, true]],
      };
}

function renderStep(): void {
  const key = override ?? probe?.next ?? null;
  const step = (key !== null && STEPS[key]) || fallbackStep();
  const actions = el("step-actions");

  // Rebuild only when the STEP changes. Rebuilding on every render — and every
  // guarded action ends in one — destroyed keyboard focus mid-interaction and
  // threw away the init form's inputs.
  if (renderedStep !== key) {
    renderedStep = key;
    el("step-body").textContent = step.body;
    el("step-hint").textContent = step.hint ?? "";
    actions.textContent = "";

    // A newer bundled server is OFFERED alongside the current step — never
    // applied unasked. The reverse (a newer server already installed) is
    // adopted silently and is not a choice: server boot runs forward-only
    // migrations, so an older binary against a migrated database is data loss.
    if (probe?.serverChoice === "upgrade-available") {
      actions.append(button(`Update server to ${probe.bundledVersion}`, doUpdateServer, false));
    }
    if (step.form) actions.append(buildForm());
    for (const [label, handler, primary, needsTmux] of step.actions()) {
      actions.append(button(label, handler, primary, needsTmux));
    }
    // Appended last and RE-CHECKED every render, not rebuilt with the step.
    // Installing tmux does not change which step you are on, so a warning (or
    // a disabled button) rebuilt only on a step change would survive its own
    // fix — worse than never having one. With the background poll this is what
    // makes the fix land on its own: tmux appears, the next tick re-checks,
    // and the buttons enable without the user doing anything.
    actions.append(tmuxWarn);
  }
  const tmuxMissing = probe !== null && !probe.tmux;
  tmuxWarn.hidden = !tmuxMissing;
  // Re-read every render, not rebuilt with the step: installing tmux or brew
  // does not change which step you are on, and a plan decided once would
  // outlive its own premise. `platform` comes from the probe (a Rust fact)
  // rather than the UA string this used to sniff. (The `probe !== null` test
  // is the same fact `tmuxMissing` encodes — restated because TS cannot see
  // through the boolean to narrow `probe`.)
  if (probe !== null && tmuxMissing) tmuxWarn.applyPlan(tmuxInstallPlan(probe.platform, probe.hasBrew));
  for (const b of actions.querySelectorAll("button")) {
    if (b.dataset.always === "1") continue;
    b.disabled = busy || (tmuxMissing && b.dataset.tmux === "1");
  }
  for (const i of actions.querySelectorAll("input")) i.disabled = busy;
}

function button(label: string, handler: () => unknown, primary?: boolean, needsTmux?: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  // The CLI refuses init/configure/service-install without tmux; a button
  // that only produces the refusal is a button that teaches the user to
  // ignore it. Flagged on the element, applied every render (see renderStep).
  if (needsTmux) b.dataset.tmux = "1";
  b.addEventListener("click", handler);
  return b;
}

/**
 * The tmux warning: the reason the buttons are gated, and the way out.
 *
 * Built ONCE and moved between step rebuilds, so nothing here may read the
 * probe — it does not exist yet at this moment. Everything plan-dependent
 * goes through `applyPlan`, which `renderStep` re-runs every render for the
 * same reason `hidden` is recomputed every render: whatever was decided once
 * here would survive its own fix (tmux appearing, `brew` appearing).
 *
 * The plan is `tmuxInstallPlan` — the platform's own installer, never a
 * bundled binary. The CLI's interactive preflight offers to run the same
 * installer; this is the non-interactive twin for the disabled buttons.
 */
type TmuxWarning = HTMLElement & { applyPlan: (plan: InstallPlan) => void };

function buildTmuxWarning(): TmuxWarning {
  const wrap = document.createElement("div");
  wrap.className = "tmux-warning";
  wrap.hidden = true;
  // Names the whole gate, not just the server verbs: the agent installs carry
  // the flag too (no pane to run an agent in without tmux), and a disabled
  // button whose reason the sentence does not name is the drift this line
  // once was.
  const p = document.createElement("p");
  p.textContent =
    "tmux was not found on the login PATH. The server launches every pane through it, so the actions that " +
    "run or configure the server, and installing an agent, are disabled until tmux is installed.";
  const row = document.createElement("div");
  // Ahead of the command it acts on, when the plan says we can run it at
  // all: a user who downloaded a GUI should not be sent to a terminal for
  // the fix a button can perform.
  const install = document.createElement("button");
  install.type = "button";
  install.className = "primary";
  install.hidden = true;
  // Wrapped, not passed by name: this function runs at module load, before
  // the `const doInstallTmux` below exists (a bare name here is a TDZ
  // ReferenceError and a blank console). A click happens long after
  // evaluation, when the guard is bound.
  install.addEventListener("click", () => doInstallTmux());
  const code = document.createElement("code");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  // Opted OUT of the busy-disable: the warning's whole moment is "an action
  // is refused until you install something" — being unable to copy the fix
  // while a re-probe is in flight is the worst possible timing.
  copy.dataset.always = "1";
  copy.addEventListener("click", () => {
    // Copies what is SHOWN: the code line and the clipboard cannot then
    // disagree, whatever `applyPlan` last wrote there.
    navigator.clipboard
      .writeText(code.textContent ?? "")
      .then(() => {
        copy.textContent = "Copied";
      })
      .catch(() => {
        copy.textContent = "Copy failed";
      })
      .finally(() => {
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1600);
      });
  });
  // Reading, not running: the no-Homebrew plan needs somewhere to go, and
  // spec §6.1 names this page. A button calling a Rust command that holds the
  // URL itself, so no URL is a value that crosses the IPC boundary — the same
  // rule `desktop_open_control_plane` follows. Opted out of the busy-disable
  // like Copy: reading the docs is most apt while something else is in flight.
  const docs = document.createElement("button");
  docs.type = "button";
  docs.textContent = "Read the docs";
  docs.dataset.always = "1";
  docs.addEventListener("click", () => {
    ipc.openTmuxDocs().catch((err: unknown) => {
      problem = errText(err);
      render();
    });
  });
  row.append(install, code, copy, docs);
  wrap.append(p, row);
  // Object.assign rather than a cast: the intersection is what this actually
  // builds (a div carrying a method), and the compiler can see it.
  return Object.assign(wrap, {
    applyPlan: (plan: InstallPlan) => {
      install.hidden = plan.kind !== "run";
      install.textContent = plan.label;
      // The command line follows the plan rather than a UA guess: on a Mac
      // without Homebrew there is no button, so this line IS the fix, and the
      // plan's MacPorts alternative is the honest thing to show — a brew line
      // would advise installing a tool we just checked is absent. An empty
      // command (a platform with nothing installable) hides the code and its
      // Copy rather than showing "tmux" as a fix it is not.
      code.textContent = plan.command.join(" ");
      code.hidden = plan.command.length === 0;
      copy.hidden = plan.command.length === 0;
      docs.hidden = !plan.docsUrl;
    },
  });
}

/** Built once and MOVED between action rebuilds; `hidden` is recomputed every render. */
const tmuxWarn: TmuxWarning = buildTmuxWarning();

/**
 * The init/configure form, seeded from what the server itself reports rather
 * than from a second copy of its defaults. See `configPayload` for why a
 * value nobody chose is still SENT as empty.
 *
 * A field the user has already typed into wins over the probe: every guarded
 * action ends with a re-probe, so re-seeding here would overwrite what someone
 * is in the middle of typing.
 */
function buildForm(): HTMLElement {
  const seeded = effectiveForm(probe?.status?.settings);
  for (const { name } of CONFIG_FIELDS) form[name] = form[name] || seeded[name];
  // Additive, and needed because the `init` step is reached without going
  // through `showConfigure`: a value already chosen (an env var, on a machine
  // with no config.env yet) must still be sent back rather than dropped.
  for (const [name, on] of Object.entries(explicitFields(probe?.status?.settings)) as [keyof ExplicitMap, boolean][]) {
    if (on) explicit[name] = true;
  }
  const wrap = document.createElement("div");
  wrap.className = "grid w-full grid-cols-2 gap-2.5";
  for (const field of CONFIG_FIELDS) {
    const { name, label, placeholder, numeric, wide, hint } = field;
    const cell = document.createElement("div");
    // A URL and a comma-separated list do not fit half a two-column grid.
    if (wide) cell.className = "col-span-2";
    const l = document.createElement("label");
    l.htmlFor = `field-${name}`;
    l.textContent = label;
    const input = document.createElement("input");
    input.id = `field-${name}`;
    input.value = form[name];
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (numeric) input.inputMode = "numeric";
    input.addEventListener("input", () => {
      form[name] = input.value;
      explicit[name] = true;
      // An untouched base URL FOLLOWS the port. The save is already safe
      // without this (unedited fields are sent empty, so the CLI re-derives),
      // but a filled field still reading `http://localhost:3080` after the
      // port became 4000 looks exactly like the value about to be written.
      if (name === "port" && explicit.baseUrl !== true) {
        form.baseUrl = derivedBaseUrl(input.value);
        const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
        if (mirror) mirror.value = form.baseUrl;
      }
    });
    cell.append(l, input);
    if (hint) {
      const h = document.createElement("p");
      h.className = "hint";
      h.textContent = hint;
      cell.append(h);
    }
    // What `status` says a BROWSER will do with the value currently stored —
    // beside the field that changes it, which is the whole reason those
    // problems travel as data rather than as a line of CLI output.
    //
    // These describe the STORED value and stay put while the field is edited.
    // A guard that hid them on edit was tried and removed: `buildForm` runs
    // only when the step changes, so it never re-ran on input and the guard
    // was dead code behind a comment claiming otherwise. Re-rendering per
    // keystroke to make it true would rebuild the inputs and lose focus — and
    // a problem about the value on disk is still true while someone types a
    // replacement, so there is nothing to hide. It clears on save, when the
    // re-probe reports the new value.
    for (const problemEntry of fieldProblems(probe?.status?.settings, name)) {
      const warn = document.createElement("p");
      warn.className = "hint warn-text";
      warn.textContent = problemEntry.reason;
      cell.append(warn);
    }
    wrap.append(cell);
  }
  return wrap;
}

function renderChip(): void {
  const svc = probe?.service;
  const running = svc?.state === "running";
  const dot = el("dot");
  dot.className = `size-2 shrink-0 rounded-full ${running ? "bg-ok" : svc?.installed ? "bg-warn" : "bg-muted"}`;
  el("state").textContent = busy
    ? "Working…"
    : probe === null
      ? "Checking…"
      : running
        ? "Running"
        : svc?.installed
          ? `Installed: ${svc.state}`
          : probe.server
            ? "Not installed as a service"
            : "No server found";
}

function render(): void {
  renderChip();
  renderFacts();
  el("problem").textContent = problem;
  renderStep();
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  // The Rust side reports the CLI's own failure text rather than letting a
  // failed `status` masquerade as an unconfigured server.
  problem = probe.error ?? "";
}

/**
 * How many extra probes a service action may wait on. A SETTLE, never a
 * poll: each attempt is two CLI spawns, and the manager flips state in well
 * under a second — the point is only that ONE re-probe lands mid-transition
 * and reads "installed but not running" on a server that came up fine.
 * Same budget the Subshell Client's action runner uses, for the same reason.
 */
const SETTLE_ATTEMPTS = 2;
const SETTLE_DELAY_MS = 1500;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap an action so two cannot run at once, the UI always re-renders, and a
 * rejection is surfaced instead of leaving every button disabled forever.
 *
 * `settle` asks for the extra re-probes: pass it when the action's WHOLE
 * POINT is a running server (install, start, restart), so the console lands
 * on `ready` rather than mid-transition. Stop and uninstall never pass it —
 * waiting for a `ready` that must not arrive is polling with extra steps.
 */
function guard(fn: () => Promise<ActionResult | null>, settle = false): () => Promise<void> {
  return async () => {
    if (busy) return;
    busy = true;
    problem = "";
    show(null);
    render();
    // The action's own failure line is applied AFTER the re-probe, not inside
    // the try: `refresh` rewrites `problem` from `probe.error`, and setting it
    // here meant an `ok:false` result erased its own message before the render
    // that was supposed to show it (measured pre-migration too; the red output
    // pane is why nobody noticed). The press the user just made outranks the
    // background state — the CLI's own words are in the pane either way.
    let failure: string | null = null;
    try {
      const result = await fn();
      if (result) show(result);
      if (result && result.ok === false) failure = "That did not work. See the output below.";
    } catch (err) {
      // A command that rejects (or a Rust `Err`) must not strand the console.
      failure = errText(err);
    }
    try {
      await refresh();
      for (let i = 0; settle && i < SETTLE_ATTEMPTS && probe?.next !== "ready"; i += 1) {
        await sleep(SETTLE_DELAY_MS);
        await refresh();
      }
    } catch (err) {
      problem = problem || `Could not read this machine's state: ${errText(err)}`;
    }
    if (failure !== null) problem = failure;
    busy = false;
    render();
  };
}

const retry = guard(async (): Promise<ActionResult | null> => null);
const service = (verb: ipc.ServiceVerb, settle = false) => guard(() => ipc.service(verb, false), settle);

/**
 * First-run configure: write config.env, then install and start the service.
 *
 * One button rather than two steps. Configuring and then being asked to
 * install a service is a distinction that serves our state machine, not the
 * person setting this up: there is no reason to write a configuration on this
 * machine and NOT run the server it configures. The `install-service` step is
 * still reachable for the case that genuinely means something, a config that
 * already exists with no service installed.
 *
 * Same shape as `doConfigure`: if the write fails, stop and report it rather
 * than acting on a configuration that is not there.
 */
const doInit = guard(async () => {
  const written = await ipc.init(configPayload(form, explicit));
  if (!written.ok) return written;
  const installed = await ipc.service("install", false);
  return installed.ok ? installed : { ...installed, stdout: `${written.stdout}\n${installed.stdout}` };
}, true);
const openMain = guard(() => ipc.openMain().then(() => null));

/**
 * The whole first-run chain, one press.
 *
 * Disclosed rather than silent: installing a binary and registering a
 * background service is not something to do unasked, so this is one INFORMED
 * click instead of four uninformed ones. The step's hint is the disclosure,
 * and it is what makes collapsing the four steps honest.
 *
 * Opening the dashboard is part of the press, but the press waits for the
 * server to ANSWER before pointing a window at it: the `ready` button and the
 * tray item have always opened it against a running server, and `service
 * start` returns when the manager has spawned the process, not when the port
 * is bound. So the settle runs here, before the open, rather than only after
 * the return. A chain that installed everything and never settles stays on
 * screen as the step that names the remainder, with the CLI's own words in
 * the pane below; a window pointed at a dead port is the one outcome this
 * press exists to remove.
 */
const doSetup = guard(async () => {
  const result = await ipc.setup();
  if (!result.ok) return result;
  for (let i = 0; i < SETTLE_ATTEMPTS && probe?.next !== "ready"; i += 1) {
    await sleep(SETTLE_DELAY_MS);
    await refresh();
  }
  if (probe?.next === "ready") {
    await ipc.openMain();
    return result;
  }
  // The settle ran out, not the setup: the chain installed and started a
  // server that has not bound its port yet (a first boot runs migrations; a
  // launchd job mid-throttle reports its wait verbatim). Say the press ended
  // without its last act, rather than letting the hint's promise of an
  // opened dashboard read as a silent lie. The background poll keeps
  // checking, and "Open Dashboard" appears on its own the moment READY lands.
  return {
    ...result,
    stdout:
      `${result.stdout}\nThe server is set up and still starting. The console keeps checking, and the ` +
      '"Open Dashboard" button appears the moment it answers.\n',
  };
}, true);

/**
 * Run the platform's own tmux installer. No settle: tmux appearing changes
 * nothing about the server — the guard's ordinary re-probe lifts the warning,
 * enables every gated button, and the package manager's own output goes to
 * the pane verbatim. The user then presses what they were going to press.
 */
const doInstallTmux = guard(() => ipc.installTmux());

/**
 * Install one agent CLI, by built-in id.
 *
 * Non-fatal by construction: it is offered during setup but never gates it,
 * because Terminal is launchable whether this succeeds or not. A setup run
 * that failed because an unrelated download 404'd would be the worst kind of
 * regression to ship here. `guard()` wraps a zero-arg function (a button's
 * click event must not reach it as a value), so the id is bound per call.
 */
const doInstallAgent = (id: string) => guard(() => ipc.installAgent(id))();

/**
 * Replacing the installed server stops it first, which ends every running
 * subshell whose definition does not spare them. That is not something to do
 * on a single click.
 */
const doUpdateServer = guard(async () => {
  const kills = probe?.service?.paneSafety !== "keeps" && probe?.service?.installed;
  const warning = kills
    ? "\n\nThe installed service definition does not spare live panes, so every running subshell will be killed."
    : "";
  const proceed = await askDialog(
    `Replace the installed server with ${probe?.bundledVersion}? The service will be stopped and restarted.${warning}`,
    { title: "Update the server", kind: kills ? "warning" : "info", okLabel: "Update" },
  );
  return proceed ? await ipc.installServer() : null;
}, true);

/**
 * Restart is refused outright when the installed definition would kill live
 * panes. The decision is taken from `paneSafety`, which is structured — the
 * prose check is only a fallback for a probe that has gone stale between the
 * render and the click.
 */
const doRestart = guard(async () => {
  const first = await ipc.service("restart", false);
  // The CLI's refusal is the only thing that means "refused". Treating any
  // failure on a `kills` host as the pane refusal offered "restart anyway" for
  // a masked unit, a dead D-Bus, or a permission error — none of which --force
  // can help, and all of which then failed a second time.
  const refused = !first.ok && first.stderr.includes("refusing to restart");
  if (first.ok || !refused) return first;
  const proceed = await askDialog(`${first.stderr.trim()}\n\nRestart anyway and lose those sessions?`, {
    title: "This will kill running subshells",
    kind: "warning",
    okLabel: "Restart anyway",
  });
  return proceed ? await ipc.service("restart", true) : first;
}, true);

/** Stop warns rather than refusing, so the warning is the thing to surface. */
const doStop = guard(() => ipc.service("stop", false));

/**
 * Open the configure form, RESEEDED from what the server currently reports —
 * an edit starts from the stored configuration, not from whatever a previous
 * visit to the form left behind.
 */
function showConfigure(): void {
  form = effectiveForm(probe?.status?.settings);
  explicit = explicitFields(probe?.status?.settings);
  override = "configure";
  renderedStep = null;
  render();
}

function cancelConfigure(): void {
  override = null;
  renderedStep = null;
  render();
}

/**
 * Rewrite config.env, then restart so the change takes effect.
 *
 * `configure` only writes the file — `constants.ts` reads every value once at
 * import, so a running server keeps its old settings until it is restarted.
 * Doing both here is what makes the button mean what it says.
 */
const doConfigure = guard(async () => {
  const written = await ipc.init(configPayload(form, explicit));
  if (!written.ok) return written;
  override = null;
  // No service yet: the file IS the whole action, and there is nothing to
  // restart — the reachable-from-`install-service` case must not answer a
  // save with a restart failure.
  if (!probe?.service?.installed) {
    return {
      ...written,
      stdout: `${written.stdout}\nSaved. It takes effect when the service is installed and started.`,
    };
  }
  const restarted = await ipc.service("restart", false);
  return restarted.ok ? restarted : { ...restarted, stdout: `${written.stdout}\n${restarted.stdout}` };
}, true);

/** The Rust side validates the chosen file and returns an Err for anything that is not a server. */
const pickBinary = guard(async () => {
  const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
  // Falsy, not "not a string": an empty string reaching `setServerBin` would
  // CLEAR the configured choice (Rust maps it to None) — silence where a
  // cancel is the only reading that fits.
  if (!chosen) return null;
  await ipc.setServerBin(chosen);
  return { ok: true, stdout: `Using ${chosen}`, stderr: "" };
});

/**
 * Why the switch is disabled, in words that stay true for a user who can see
 * their own tray icon while reading them — the probe is a false negative on
 * the older XEmbed tray, so it says DETECTED, never "there is none".
 */
const TRAY_NOT_DETECTED =
  "No system tray was detected on this desktop, so a hidden window would have nowhere to go. GNOME needs an " +
  "AppIndicator extension; KDE and most others have one already. Some older trays cannot be detected at all, so " +
  "an icon may still appear. Install one, then check again.";

/**
 * The tray preference, and why it is sometimes offered but not live.
 *
 * On Linux the icon is drawn only where a StatusNotifier host is registered on
 * the session bus: KDE has one, a stock GNOME needs the AppIndicator
 * extension, and where none is registered the icon is silently invisible — so
 * a window hidden into it is unreachable. The Rust side answers that with a
 * real probe rather than a platform check and reports both halves:
 * `traySupported` for whether the switch is live, `trayStatus` for whether an
 * absent tray is worth explaining.
 *
 * - `supported` — the switch works.
 * - `not-detected` — DISABLED, with the reason and a re-check. Deliberately
 *   not hidden: naming the extension is actionable, an absent control is not,
 *   and installing it flips the answer without restarting the app.
 * - `unsupported` — no tray on this platform at all, so the card is not drawn.
 */
async function loadPrefs(): Promise<void> {
  let prefs;
  try {
    prefs = await ipc.settings();
  } catch (err) {
    // Never leaves the card mid-state or the rejection unhandled: this is also
    // the re-check button's path, and a refused command there must say so.
    problem = errText(err);
    render();
    return;
  }
  el("prefs-card").hidden = prefs.trayStatus === "unsupported";
  const box = el("close-to-tray") as HTMLInputElement;
  box.checked = prefs.closeToTray;
  box.disabled = !prefs.traySupported;
  el("tray-missing").hidden = prefs.traySupported;
  el("tray-reason").textContent = prefs.traySupported ? "" : TRAY_NOT_DETECTED;
}

/**
 * Not through `guard()`: it re-probes, and a checkbox is not worth two CLI
 * spawns of something it cannot change. It still surfaces a refusal — the
 * Rust side rejects `true` where no tray answered — and it re-reads the
 * preference afterwards, so the box shows what was actually stored rather than
 * what was clicked.
 */
el("close-to-tray").addEventListener("change", async () => {
  try {
    await ipc.setCloseToTray((el("close-to-tray") as HTMLInputElement).checked);
    problem = "";
  } catch (err) {
    problem = errText(err);
  }
  await loadPrefs();
  render();
});

el("tray-recheck").addEventListener("click", () => {
  void loadPrefs();
});

/**
 * How often the console re-reads the machine on its own.
 *
 * The manager's whole subject is state this app does not own — a service that
 * can be started, stopped or crash from anywhere — so a console that only
 * refreshes when asked shows a stale answer and puts the burden of noticing on
 * the user. It also drives the TRAY's enabled state (`desktop_probe` is the
 * one place that updates), so without this a server started elsewhere leaves
 * the tray disabled until someone opens this window and clicks.
 *
 * This is the poll that `SETTLE_ATTEMPTS` deliberately is NOT, so it pays the
 * same cost honestly: each tick is a few short CLI spawns. What makes it
 * affordable is that the expensive parts happen ONCE per process, not per
 * probe — the login-shell PATH probe and the bundled binary's version are both
 * memoized behind a `OnceLock` in the Rust half. Five seconds is chosen to be
 * faster than a person reaches for the button and slower than the manager
 * changes its mind.
 */
const POLL_MS = 5000;

/**
 * A background re-probe. Skipped in two cases, both of which would make it
 * harmful rather than merely wasteful:
 *
 * - **`busy`** — an action owns the state, ends in its own re-probe, and may
 *   be mid-SETTLE. A poll landing in the middle would race that and could
 *   render a transition as the final answer.
 * - **hidden** — a window closed to the tray is watched by nobody, and paying
 *   CLI spawns forever for a view no one can see is the cost with none of the
 *   benefit. Best-effort: platforms differ on whether a hidden native window
 *   reports `document.hidden`, so this is a saving, not a guarantee.
 *
 * A failed poll is swallowed on purpose. `refresh` already records the CLI's
 * own words in `problem`, and a transient failure nobody asked about must not
 * become an unhandled rejection.
 */
async function poll(): Promise<void> {
  if (busy || document.hidden) return;
  try {
    await refresh();
  } catch {
    return;
  }
  render();
  // Separate try: a log tail that cannot be read must not stop the probe's
  // result from being rendered.
  try {
    await refreshLog();
  } catch {
    /* the pane keeps its last content */
  }
}

for (const id of ["log", "output"] as const) {
  el(`tab-${id}`).addEventListener("click", () => showPane(id));
}

setInterval(() => void poll(), POLL_MS);
// A window being shown again should not wait out the rest of the interval —
// that is exactly when its contents are most likely to be stale.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poll();
});

showPane("log");
render();
void retry();
void loadPrefs();
void refreshLog().catch(() => {});
