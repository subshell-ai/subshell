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
const form = { port: "", host: "" };
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

function fact(dl, key, value, cls) {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  dl.append(dt, dd);
}

function renderFacts() {
  const dl = el("facts");
  dl.textContent = "";
  const svc = probe?.service ?? null;
  const st = probe?.status ?? null;
  if (probe?.server) {
    fact(dl, "server", `${probe.server.version ?? "?"} — ${probe.server.argv.join(" ")}`);
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
  if (st?.configEnv) fact(dl, "config.env", `${st.configEnv.path} (${st.configEnv.exists ? "present" : "missing"})`);
  if (st?.settings?.APP_BASE_URL) fact(dl, "base URL", st.settings.APP_BASE_URL.value);
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
    fact(dl, "service", svc.definitionPath);
    fact(dl, "manager", svc.state + (svc.pid ? ` (pid ${svc.pid})` : ""));
    // The one fact neither systemctl nor launchctl will tell them.
    if (svc.paneSafety === "kills") {
      fact(dl, "teardown", "kills live panes — reinstall the service definition", "warn-text");
    } else if (svc.paneSafety === "unknown") {
      fact(dl, "teardown", "unknown — the definition could not be read", "warn-text");
    }
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
    hint: "Nothing has been changed. Retry, or choose a different binary — this app will not rewrite a configuration it cannot read.",
    actions: () => [
      ["Retry", act(null), true],
      ["Choose a different one…", pickBinary],
    ],
  },
  init: {
    body: "The server has no config.env yet. Choose a port and host.",
    hint: "Written to ~/.config/subshell-server/config.env (0600), with a fresh auth secret.",
    form: true,
    actions: () => [["Create configuration", doInit, true]],
  },
  "install-service": {
    body: "Configured. Install it as a background service so it starts at login.",
    hint: "A systemd user unit on Linux, a launchd agent on macOS.",
    actions: () => [["Install as a service", service("install"), true]],
  },
  start: {
    body: "The service is installed but not running.",
    actions: () => [
      ["Start", service("start"), true],
      ["Uninstall service", service("uninstall")],
    ],
  },
  ready: {
    body: "The server is running.",
    actions: () => [
      ["Open Subshell", openMain, true],
      ["Restart", doRestart],
      ["Stop", doStop],
      ["Change port or host…", showConfigure],
    ],
  },
  // Reached from `ready`, not from the probe: this is an edit of a working
  // configuration, so it is something the user asks for rather than something
  // the machine's state implies.
  configure: {
    body: "Change the port or host this server listens on.",
    hint: "config.env is rewritten. The running server keeps its current settings until it restarts.",
    form: true,
    actions: () => [
      ["Save and restart", doConfigure, true],
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
    for (const [label, handler, primary] of step.actions()) {
      actions.append(button(label, handler, primary));
    }
  }
  for (const b of actions.querySelectorAll("button")) b.disabled = busy;
  for (const i of actions.querySelectorAll("input")) i.disabled = busy;
}

function button(label, handler, primary) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", handler);
  return b;
}

/** The init form, seeded from what the server itself reports rather than from a third copy of its defaults. */
function buildForm() {
  const settings = probe?.status?.settings ?? {};
  form.port = form.port || settings.SERVER_PORT?.value || "";
  form.host = form.host || settings.HOST?.value || "";
  const wrap = document.createElement("div");
  wrap.className = "grid2";
  wrap.style.width = "100%";
  for (const [name, label, placeholder] of [
    ["port", "Port", "3080"],
    ["host", "Host", "127.0.0.1"],
  ]) {
    const cell = document.createElement("div");
    const l = document.createElement("label");
    l.htmlFor = `field-${name}`;
    l.textContent = label;
    const input = document.createElement("input");
    input.id = `field-${name}`;
    input.value = form[name];
    input.placeholder = placeholder;
    if (name === "port") input.inputMode = "numeric";
    input.addEventListener("input", () => {
      form[name] = input.value;
    });
    cell.append(l, input);
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
 * Wrap an action so two cannot run at once, the UI always re-renders, and a
 * rejection is surfaced instead of leaving every button disabled forever.
 */
function guard(fn) {
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
    } catch (err) {
      problem = problem || `Could not read this machine's state: ${String(err?.message ?? err)}`;
    }
    busy = false;
    render();
  };
}

const act = (cmd, args) => guard(() => (cmd ? invoke(cmd, args) : null));
const service = (verb) => guard(() => invoke("desktop_service", { verb, force: false }));

const doInit = guard(() => invoke("desktop_init", { port: form.port, host: form.host }));
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
});

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
});

/** Stop warns rather than refusing, so the warning is the thing to surface. */
const doStop = guard(async () => {
  const result = await invoke("desktop_service", { verb: "stop", force: false });
  return result;
});

/** Open the configure form, seeded from what the server currently reports. */
function showConfigure() {
  const settings = probe?.status?.settings ?? {};
  form.port = settings.SERVER_PORT?.value ?? "";
  form.host = settings.HOST?.value ?? "";
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
  const written = await invoke("desktop_init", { port: form.port, host: form.host });
  if (!written.ok) return written;
  override = null;
  const restarted = await invoke("desktop_service", { verb: "restart", force: false });
  return restarted.ok ? restarted : { ...restarted, stdout: `${written.stdout}\n${restarted.stdout}` };
});

/** The Rust side validates the chosen file and returns an Err for anything that is not a server. */
const pickBinary = guard(async () => {
  const chosen = await dialog().open({ multiple: false, directory: false, title: "Choose subshell-server" });
  if (!chosen) return null;
  await invoke("desktop_set_server_bin", { path: chosen });
  return { ok: true, stdout: `Using ${chosen}` };
});

/**
 * The tray preference, and why it is not always offered.
 *
 * On Linux `TrayIconEvent` is never emitted and a stock GNOME has no
 * StatusNotifier host, so the icon can be silently invisible — a window hidden
 * to an icon that is not there is unreachable, with nothing to explain it. The
 * Rust side reports whether the switch is safe to show, and refuses to persist
 * `true` where it is not; the console just does not draw it.
 */
async function loadPrefs() {
  const prefs = await invoke("desktop_settings");
  const card = el("prefs-card");
  card.hidden = !prefs.traySupported;
  if (!prefs.traySupported) return;
  const box = el("close-to-tray");
  box.checked = prefs.closeToTray;
  box.addEventListener("change", () => {
    void invoke("desktop_set_close_to_tray", { enabled: box.checked });
  });
}

el("refresh").addEventListener("click", act(null));
render();
void act(null)();
void loadPrefs();
