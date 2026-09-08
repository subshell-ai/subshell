/**
 * The server console — the one surface that must render with the server DOWN,
 * and the only one allowed to drive the `subshell-server` CLI.
 *
 * Deliberately framework-free and dependency-free: a second copy of React,
 * Tailwind and the design system to draw a status panel and six buttons would
 * be a build step between the user and the thing that fixes their broken
 * install. It is a module rather than an inline script so a real CSP can apply
 * (`script-src 'self'`) and so biome lints it as code.
 *
 * The CLI owns every operator-facing message — the `loginctl enable-linger`
 * hint, the tmux refusal, the live-pane warning — so its stdout and stderr are
 * shown VERBATIM and never re-worded here. Two surfaces that phrase the same
 * refusal differently are two surfaces that drift.
 */

import { CONFIG_FIELDS, configPayload, fieldProblems, seedForm } from "./config-form.js";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const dialog = () => window.__TAURI__.dialog;
const el = (id) => document.getElementById(id);

/** Latest probe, or null before the first one lands. */
let probe = null;
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
let form = seedForm(undefined);
/** Which step the action area currently shows, so focus survives a re-render. */
let renderedStep = null;

/** Show a result's own words. `ok:false` is styled as a failure, not as output. */
function show(result) {
  const parts = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  const out = el("output");
  out.textContent = parts.join("\n\n");
  out.classList.toggle("output-bad", result?.ok === false);
}

/**
 * One facts row, optionally carrying an action — a path to reveal in the
 * file manager, the control plane to open in a browser.
 *
 * The action names an intent, never a path: the Rust side re-reads the path
 * from its own probe, so a row can only ever reveal the fact it is showing.
 */
function fact(dl, key, value, cls, action) {
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
function reveal(target) {
  invoke("desktop_open_path", { target }).catch((err) => {
    problem = String(err?.message ?? err);
    render();
  });
}
const revealAction = (target, label = "Reveal") => ({ label, run: () => reveal(target) });

/** Open the control plane's URL in the SYSTEM browser — the address row shows, not a URL from this side. */
function openControlPlane() {
  invoke("desktop_open_control_plane").catch((err) => {
    problem = String(err?.message ?? err);
    render();
  });
}

function renderFacts() {
  const dl = el("facts");
  dl.textContent = "";
  const svc = probe?.service ?? null;
  const st = probe?.status ?? null;
  if (probe?.server) {
    fact(
      dl,
      "server",
      `${probe.server.version ?? "?"} — ${probe.server.argv.join(" ")}`,
      null,
      revealAction("server-dir"),
    );
    fact(dl, "found via", probe.server.source);
  }
  if (probe?.bundledVersion) {
    const note =
      probe.serverChoice === "adopt-installed"
        ? " — the installed server is newer, so it is the one in use"
        : probe.serverChoice === "upgrade-available"
          ? " — newer than the installed one"
          : "";
    fact(dl, "bundled", probe.bundledVersion + note, note ? "warn-text" : null);
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
    fact(dl, "control plane URL", st.settings.APP_BASE_URL.value, null, {
      label: "Open in browser",
      run: openControlPlane,
    });
  }
  // From the PROBE, not from `status` — tmux is a hard stop on `init` and
  // `service install`, and on a clean machine there is no server to ask yet.
  if (probe) {
    fact(dl, "tmux", probe.tmux ?? "NOT FOUND — install it before continuing", probe.tmux ? null : "bad-text");
  }
  // An unresolved MCP entrypoint means every subshell create 500s. It is the
  // one status fact that predicts a failure the user would otherwise meet
  // later, in a completely different part of the app.
  if (st && !st.mcp) {
    fact(dl, "mcp entrypoint", `UNRESOLVED — subshell create will fail; ${st.mcpError ?? ""}`.trim(), "bad-text");
  }
  // A server can be listening without being service-managed (someone started
  // it in a terminal). Without this the console insists it is "stopped" while
  // the app plainly works.
  if (st?.listen?.listening && svc?.state !== "running") {
    fact(dl, "port", `something is already listening on ${st.listen.portRaw}`, "warn-text");
  }
  if (svc?.installed) {
    fact(dl, "service", svc.definitionPath, null, revealAction("service-definition"));
    // `detail` carries what the manager said verbatim — `launchd: spawn
    // scheduled` is the crash-throttle state, and "stopped" alone hides it.
    fact(
      dl,
      "manager",
      svc.state + (svc.pid ? ` (pid ${svc.pid})` : "") + (svc.detail ? ` — ${svc.detail}` : ""),
      svc.state === "unknown" ? "bad-text" : null,
    );
    // The one fact neither systemctl nor launchctl will tell them.
    if (svc.paneSafety === "kills") {
      fact(dl, "teardown", "kills live panes — reinstall the service definition", "warn-text");
    } else if (svc.paneSafety === "unknown") {
      fact(dl, "teardown", "unknown — the definition could not be read", "warn-text");
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
    fact(dl, "logs", "the systemd journal — journalctl --user -u subshell-server.service -f");
  }
}

/**
 * One entry per `ProbeStep` the Rust side can emit.
 *
 * `Object.create(null)` so a step named `constructor` or `toString` cannot
 * resolve to something inherited and crash the render loop.
 */
const STEPS = Object.assign(Object.create(null), {
  "no-server": {
    body: "No subshell-server was found, and this build does not ship one.",
    hint: "Point the app at a server binary you already have.",
    actions: () => [["Choose subshell-server…", pickBinary, true]],
  },
  "install-server": {
    body: "Ready to install the bundled subshell-server to ~/.local/bin.",
    hint: "Nothing is downloaded — the server ships inside this app.",
    actions: () => [
      ["Install server", act("desktop_install_server"), true],
      ["Choose an existing one…", pickBinary],
    ],
  },
  unreachable: {
    body: "A subshell-server was found, but it did not answer.",
    hint: "Nothing has been changed. Retry, or choose a different binary — this app will not rewrite a configuration it cannot read. If the answer you expect is a different port or address, edit it here.",
    actions: () => [
      ["Retry", act(null), true],
      ["Choose a different one…", pickBinary],
      ["Change addresses…", showConfigure],
    ],
  },
  init: {
    body: "The server has no config.env yet. Choose the port and the addresses it will answer to.",
    hint: "Written to ~/.config/subshell-server/config.env (0600), with a fresh auth secret.",
    form: true,
    actions: () => [["Create configuration", doInit, true, true]],
  },
  "install-service": {
    body: "Configured. Install it as a background service so it starts at login.",
    hint: "A systemd user unit on Linux, a launchd agent on macOS. Installing also starts it.",
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
      ["Open Subshell Server", openMain, true],
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
      "one you browse from. config.env is rewritten; the running server keeps its current settings until it restarts.",
    form: true,
    actions: () => [
      ["Save and restart", doConfigure, true, true],
      ["Cancel", cancelConfigure],
    ],
  },
});

/**
 * `configure` is a step the USER chooses, so it cannot come from the probe —
 * which reports what the machine implies. Held beside `probe.next` and cleared
 * whenever the flow moves on.
 */
let override = null;

/** What to show before the first probe lands, or for a step this build predates. */
function fallbackStep() {
  return probe === null
    ? { body: "Checking this machine…", actions: () => [] }
    : {
        body: `This app does not know what to do about "${probe.next}".`,
        hint: "That usually means the app is older than the server it is managing.",
        actions: () => [["Retry", act(null), true]],
      };
}

function renderStep() {
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
    // Appended last and RE-CHECKED every render, not rebuilt with the step:
    // installing tmux and pressing Refresh does not change the step, and a
    // warning or a disabled button that survived its own fix would be worse
    // than never having one.
    actions.append(tmuxWarn);
  }
  const tmuxMissing = probe !== null && !probe.tmux;
  tmuxWarn.hidden = !tmuxMissing;
  for (const b of actions.querySelectorAll("button")) {
    if (b.dataset.always === "1") continue;
    b.disabled = busy || (tmuxMissing && b.dataset.tmux === "1");
  }
  for (const i of actions.querySelectorAll("input")) i.disabled = busy;
}

function button(label, handler, primary, needsTmux) {
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
 * tmux advice per platform. The CLI's own interactive preflight offers to run
 * the installer; this is the non-interactive twin for the disabled buttons —
 * the same commands `commands/tmux-install.ts` uses.
 */
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);
const TMUX_INSTALL_CMD = IS_MAC ? "brew install tmux" : "sudo apt-get install tmux";

function buildTmuxWarning() {
  const wrap = document.createElement("div");
  wrap.className = "tmux-warning";
  wrap.hidden = true;
  const p = document.createElement("p");
  p.textContent =
    "tmux was not found on the login PATH. The server launches every pane through it, so configuring and " +
    "starting are disabled until it is installed.";
  const row = document.createElement("div");
  row.className = "row";
  const code = document.createElement("code");
  code.textContent = TMUX_INSTALL_CMD;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  // Opted OUT of the busy-disable: the warning's whole moment is "an action
  // is refused until you install something" — being unable to copy the fix
  // while a re-probe is in flight is the worst possible timing.
  copy.dataset.always = "1";
  copy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(TMUX_INSTALL_CMD)
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
  row.append(code, copy);
  wrap.append(p, row);
  return wrap;
}

/** Built once and MOVED between action rebuilds; `hidden` is recomputed every render. */
const tmuxWarn = buildTmuxWarning();

/**
 * The init/configure form, seeded from what the server itself reports rather
 * than from a second copy of its defaults — see `seedForm` for why a
 * `default`-sourced value is deliberately left blank.
 *
 * A field the user has already typed into wins over the probe: every guarded
 * action ends with a re-probe, so re-seeding here would overwrite what someone
 * is in the middle of typing.
 */
function buildForm() {
  const seeded = seedForm(probe?.status?.settings);
  for (const { name } of CONFIG_FIELDS) form[name] = form[name] || seeded[name];
  const wrap = document.createElement("div");
  wrap.className = "grid2";
  wrap.style.width = "100%";
  for (const field of CONFIG_FIELDS) {
    const { name, label, placeholder, numeric, wide, hint } = field;
    const cell = document.createElement("div");
    // A URL and a comma-separated list do not fit half a two-column grid.
    if (wide) cell.className = "span2";
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
    for (const problem of fieldProblems(probe?.status?.settings, name)) {
      const warn = document.createElement("p");
      warn.className = "hint warn-text";
      warn.textContent = problem.reason;
      cell.append(warn);
    }
    wrap.append(cell);
  }
  return wrap;
}

function renderChip() {
  const svc = probe?.service;
  const running = svc?.state === "running";
  const dot = el("dot");
  dot.className = `dot ${running ? "ok" : svc?.installed ? "warn" : ""}`.trim();
  el("state").textContent = busy
    ? "Working…"
    : probe === null
      ? "Checking…"
      : running
        ? "Running"
        : svc?.installed
          ? `Installed — ${svc.state}`
          : probe.server
            ? "Not installed as a service"
            : "No server found";
  el("refresh").disabled = busy;
}

function render() {
  renderChip();
  renderFacts();
  el("problem").textContent = problem;
  renderStep();
}

async function refresh() {
  probe = await invoke("desktop_probe");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap an action so two cannot run at once, the UI always re-renders, and a
 * rejection is surfaced instead of leaving every button disabled forever.
 *
 * `settle` asks for the extra re-probes: pass it when the action's WHOLE
 * POINT is a running server (install, start, restart), so the console lands
 * on `ready` rather than mid-transition. Stop and uninstall never pass it —
 * waiting for a `ready` that must not arrive is polling with extra steps.
 */
function guard(fn, settle = false) {
  return async () => {
    if (busy) return;
    busy = true;
    problem = "";
    show(null);
    render();
    try {
      const result = await fn();
      if (result) show(result);
      if (result && result.ok === false) problem = "That did not work — see the output below.";
    } catch (err) {
      // A command that rejects (or a Rust `Err`) must not strand the console.
      problem = String(err?.message ?? err);
    }
    try {
      await refresh();
      for (let i = 0; settle && i < SETTLE_ATTEMPTS && probe?.next !== "ready"; i += 1) {
        await sleep(SETTLE_DELAY_MS);
        await refresh();
      }
    } catch (err) {
      problem = problem || `Could not read this machine's state: ${String(err?.message ?? err)}`;
    }
    busy = false;
    render();
  };
}

const act = (cmd, args) => guard(() => (cmd ? invoke(cmd, args) : null));
const service = (verb, settle) => guard(() => invoke("desktop_service", { verb, force: false }), settle);

const doInit = guard(() => invoke("desktop_init", configPayload(form)));
const openMain = guard(() => invoke("desktop_open_main"));

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
  const proceed = await dialog().ask(
    `Replace the installed server with ${probe.bundledVersion}? The service will be stopped and restarted.${warning}`,
    { title: "Update the server", kind: kills ? "warning" : "info", okLabel: "Update" },
  );
  return proceed ? invoke("desktop_install_server") : null;
}, true);

/**
 * Restart is refused outright when the installed definition would kill live
 * panes. The decision is taken from `paneSafety`, which is structured — the
 * prose check is only a fallback for a probe that has gone stale between the
 * render and the click.
 */
const doRestart = guard(async () => {
  const first = await invoke("desktop_service", { verb: "restart", force: false });
  // The CLI's refusal is the only thing that means "refused". Treating any
  // failure on a `kills` host as the pane refusal offered "restart anyway" for
  // a masked unit, a dead D-Bus, or a permission error — none of which --force
  // can help, and all of which then failed a second time.
  const refused = !first.ok && first.stderr.includes("refusing to restart");
  if (first.ok || !refused) return first;
  const proceed = await dialog().ask(`${first.stderr.trim()}\n\nRestart anyway and lose those sessions?`, {
    title: "This will kill running subshells",
    kind: "warning",
    okLabel: "Restart anyway",
  });
  return proceed ? invoke("desktop_service", { verb: "restart", force: true }) : first;
}, true);

/** Stop warns rather than refusing, so the warning is the thing to surface. */
const doStop = guard(async () => {
  const result = await invoke("desktop_service", { verb: "stop", force: false });
  return result;
});

/**
 * Open the configure form, RESEEDED from what the server currently reports —
 * an edit starts from the stored configuration, not from whatever a previous
 * visit to the form left behind.
 */
function showConfigure() {
  form = seedForm(probe?.status?.settings);
  override = "configure";
  renderedStep = null;
  render();
}

function cancelConfigure() {
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
  const written = await invoke("desktop_init", configPayload(form));
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
  const restarted = await invoke("desktop_service", { verb: "restart", force: false });
  return restarted.ok ? restarted : { ...restarted, stdout: `${written.stdout}\n${restarted.stdout}` };
}, true);

/** The Rust side validates the chosen file and returns an Err for anything that is not a server. */
const pickBinary = guard(async () => {
  const chosen = await dialog().open({ multiple: false, directory: false, title: "Choose subshell-server" });
  if (!chosen) return null;
  await invoke("desktop_set_server_bin", { path: chosen });
  return { ok: true, stdout: `Using ${chosen}` };
});

/**
 * Why the switch is disabled, in words that stay true for a user who can see
 * their own tray icon while reading them — the probe is a false negative on
 * the older XEmbed tray, so it says DETECTED, never "there is none".
 */
const TRAY_NOT_DETECTED =
  "No system tray was detected on this desktop, so a hidden window would have nowhere to go. GNOME needs an " +
  "AppIndicator extension; KDE and most others have one already. Some older trays cannot be detected at all, so " +
  "an icon may still appear — install one, then check again.";

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
async function loadPrefs() {
  let prefs;
  try {
    prefs = await invoke("desktop_settings");
  } catch (err) {
    // Never leaves the card mid-state or the rejection unhandled: this is also
    // the re-check button's path, and a refused command there must say so.
    problem = String(err?.message ?? err);
    render();
    return;
  }
  el("prefs-card").hidden = prefs.trayStatus === "unsupported";
  const box = el("close-to-tray");
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
    await invoke("desktop_set_close_to_tray", { enabled: el("close-to-tray").checked });
    problem = "";
  } catch (err) {
    problem = String(err?.message ?? err);
  }
  await loadPrefs();
  render();
});

el("tray-recheck").addEventListener("click", () => {
  void loadPrefs();
});

el("refresh").addEventListener("click", act(null));
render();
void act(null)();
void loadPrefs();
