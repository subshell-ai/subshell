/**
 * Subshell Node's only page — state, steps and actions.
 *
 * The whole product is one sentence: paste a server URL and a setup key, and
 * this machine becomes a node that agents can be launched on, without ever
 * meeting the CLI. This file is the behavior behind that sentence;
 * `probe-view.js` reads the machine's state, `copy.js` holds the words, and
 * `dom.js` builds nodes. No framework, no build step, no npm dependency: a
 * second copy of React, Tailwind and the design system to draw a status panel
 * and a three-field form would be a build step between the user and the thing
 * that registers their machine. The page must render on a box that has never
 * met a control plane, with nothing installed and nothing running.
 *
 * Two rules carry most of the weight:
 *
 * 1. **The CLI owns every operator-facing message.** `apps/client` phrases the
 *    tmux refusal, the `loginctl enable-linger` hint, the live-pane refusal and
 *    every enrollment failure, and its strings are pinned by its own tests. So
 *    `stdout`/`stderr` are shown VERBATIM and never re-worded here. Two
 *    surfaces that phrase one refusal differently are two surfaces that drift.
 *    Decisions key off exit status and structured fields, never off prose —
 *    with one deliberate exception, documented at {@link doRestart}.
 * 2. **Nothing destructive happens on one click.** A setup key is single-use
 *    and 24-hour, `enroll` has no already-enrolled guard, and a restart on a
 *    stale service definition SIGKILLs every subshell on this machine. Each of
 *    those goes through the confirmation panel, which names the cost in the
 *    Rust side's words (or the CLI's) before the button that pays it.
 *
 * The page never invents state: {@link STEPS} is keyed by the `ProbeStep` enum
 * in `src-tauri/src/control.rs`, and every guarded action ends by re-probing.
 */

import { ENROLL_NOTES, FIELDS, LOOPBACK_NOTE, MAX_NODE_NAME_LEN, SETUP_KEY_RE, tmuxHint } from "./copy.js";
import { button, el, list, paragraph, show, sleep, text } from "./dom.js";
import { isLoopback, paneRisk, renderChip, renderFacts } from "./probe-view.js";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const dialog = () => window.__TAURI__.dialog;

/** Latest `node_probe`, or null before the first one lands. */
let probe = null;
/** Latest `node_settings`. */
let prefs = null;
/** True while a command is in flight; every control is disabled meanwhile. */
let busy = false;
/** Why the last action or probe failed, in the CLI's (or Rust's) words. */
let problem = "";
/**
 * A step the USER chose rather than one the machine implies — today only
 * `enroll`, reached from an already-registered machine. Cleared whenever the
 * flow moves on.
 */
let override = null;
/** The pending confirmation, or null. See {@link ask}. */
let pending = null;
let pendingSeq = 0;
/** Which step the action area currently shows, so focus survives a re-render. */
let renderedStep = null;
/** Which confirmation the confirm panel currently shows. */
let renderedPending = null;
/**
 * The `enroll --json` body from a successful enrollment in THIS session.
 *
 * The only place the node's display NAME is knowable: `status --json` reports
 * `nodeId`/`serverUrl`/`online` and no name, and `config.json`'s name is not
 * among the three facts the Rust side is willing to hand out. So the name is
 * shown when this app just chose it and is silently absent otherwise, rather
 * than being guessed at from the hostname — which is a default, not a fact.
 */
let enrolledNode = null;

/**
 * The enroll form's values, held OUTSIDE the DOM.
 *
 * The form is rebuilt whenever the step changes, and every guarded action ends
 * with a re-probe — so reading `input.value` at click time races the rebuild.
 * The typed value is the state; the input is a view of it.
 */
const form = { server: "", key: "", name: "" };
/** Per-field validation refusals, keyed like {@link form}. */
const fieldErrors = { server: "", key: "", name: "" };
/** Live `<p>` handles for each field's note, so validating does not rebuild (and unfocus) the form. */
const fieldNotes = { server: null, key: null, name: null };

// ---------------------------------------------------------------------------
// The enroll form
// ---------------------------------------------------------------------------

/**
 * Check what can be checked before a setup key is spent.
 *
 * The same three rules as `validate_server_url` / `validate_setup_key` /
 * `validate_node_name` on the Rust side, run here so a typo never reaches a
 * spawn. The Rust side still runs them — this is a courtesy, not the gate.
 * The KEY is never echoed into a message: it is a one-time credential, and an
 * error string is the easiest place for one to end up on a screenshot.
 */
function validateEnroll() {
  const server = form.server.trim();
  const key = form.key.trim();
  const name = form.name.trim();
  fieldErrors.server = "";
  fieldErrors.key = "";
  fieldErrors.name = "";

  if (server === "") {
    fieldErrors.server = "Enter the control plane's URL, e.g. https://subshell.example.com";
  } else {
    let parsed = null;
    try {
      parsed = new URL(server);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      fieldErrors.server = `'${server}' is not a full URL — include the scheme, e.g. https://subshell.example.com`;
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fieldErrors.server = `The server URL must be http or https, not '${parsed.protocol.replace(":", "")}'.`;
    } else if (parsed.hostname === "") {
      fieldErrors.server = `'${server}' names no host.`;
    }
  }

  if (key === "") {
    fieldErrors.key = "Paste the setup key minted on the Nodes page.";
  } else if (!SETUP_KEY_RE.test(key)) {
    fieldErrors.key = "A setup key is `nsk_` followed by 32 letters, digits, `-` or `_`. Check for a partial paste.";
  }

  const nameLength = [...name].length;
  if (nameLength > MAX_NODE_NAME_LEN) {
    fieldErrors.name = `That name is ${nameLength} characters — the control plane accepts at most ${MAX_NODE_NAME_LEN}.`;
  }

  renderFieldNotes();
  return {
    invalid: Boolean(fieldErrors.server || fieldErrors.key || fieldErrors.name),
    // Blank means "let the agent default to this machine's hostname", which is
    // what the CLI does — this app cannot read the hostname and will not guess.
    args: { server, key, name: name === "" ? null : name },
  };
}

/** A field's error, else its advisory. Updated in place so focus survives. */
function renderFieldNotes() {
  for (const { name } of FIELDS) {
    const node = fieldNotes[name];
    if (!node) continue;
    const error = fieldErrors[name];
    const advisory = name === "server" && !error && isLoopback(form.server) ? LOOPBACK_NOTE : "";
    node.textContent = error || advisory;
    node.className = `field-note${error ? " bad-text" : advisory ? " warn-text" : ""}`;
  }
}

function buildEnrollForm() {
  const wrap = document.createElement("div");
  wrap.className = "fields";
  for (const { name, label, placeholder } of FIELDS) {
    const cell = document.createElement("div");
    cell.className = "field";
    const l = document.createElement("label");
    l.htmlFor = `field-${name}`;
    l.textContent = label;
    const input = document.createElement("input");
    input.id = `field-${name}`;
    input.type = "text";
    input.value = form[name];
    input.placeholder = placeholder;
    // A setup key and a URL are both pasted, never dictated: autocorrect on
    // either turns a working credential into a support question. The key is
    // deliberately NOT masked — it is single-use, 24-hour, and cleared on
    // success, and seeing that a paste landed whole is worth more here than
    // hiding it from the room.
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.addEventListener("input", () => {
      form[name] = input.value;
      fieldErrors[name] = "";
      renderFieldNotes();
    });
    const note = paragraph("", "field-note");
    fieldNotes[name] = note;
    cell.append(l, input, note);
    wrap.append(cell);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/** Reveal buttons every registered screen carries. */
const pathActions = () => [
  ["Reveal configuration", openPath("config-dir")],
  // Offered on every platform even though Linux has no log FILE: the Rust side
  // rejects with the `journalctl` command to run instead, which is the
  // actionable answer and the only place a user would find it.
  ["Open the agent log", openPath("agent-log")],
];

/** The non-destructive remedy for a definition that would kill live panes. */
const rewriteAction = () =>
  paneRisk(probe) ? [["Rewrite the service definition", service("install", { settle: true })]] : [];

const reenrollAction = () => [["Re-enroll this machine…", showEnroll]];

/**
 * One entry per `ProbeStep` the Rust side can emit, plus `enroll` — the one
 * step the USER chooses rather than the machine implying it.
 *
 * `Object.create(null)` so a step named `constructor` or `toString` cannot
 * resolve to something inherited and crash the render loop.
 */
const STEPS = Object.assign(Object.create(null), {
  "no-agent": {
    // Two very different situations share this step, on purpose: a binary that
    // answered `version` but not `status --json` must NOT route to enroll,
    // because a transient read failure would then overwrite a live config.
    body: () =>
      probe?.agent
        ? "An agent was found on this machine, but it could not report its status."
        : "No subshell agent was found on this machine.",
    notes: () =>
      probe?.agent
        ? [
            "Nothing has been changed. This app will not offer to register a machine whose agent cannot say whether " +
              "it is already a node: enrolling overwrites the existing configuration and discards its node key.",
          ]
        : [
            "The agent is the small program that holds this machine's connection to the control plane and starts " +
              "the sessions launched here. Installing it copies the copy that ships inside this app to " +
              "~/.local/bin/subshell — nothing is downloaded.",
          ],
    actions: () => {
      const out = [];
      if (probe?.bundledVersion) out.push(["Install the agent", act("node_install_agent"), !probe?.agent]);
      if (probe?.agent) out.push(["Retry", act(null), true]);
      out.push(["Choose an existing agent…", pickBinary]);
      if (prefs?.agentBinPath) out.push(["Forget the chosen binary", clearBinary]);
      return out;
    },
    hint: () => (probe?.bundledVersion ? "" : "This build ships no agent, so an existing one has to be pointed at."),
  },

  "not-enrolled": {
    body: "This machine has an agent but is not registered with a control plane yet.",
    notes: ENROLL_NOTES,
    form: true,
    actions: () => [["Enroll this machine", doEnroll, true]],
    hint: () => tmuxHint(probe, "enroll"),
  },

  // Reached from a registered step, never from the probe: re-enrolling is
  // something a user asks for, not something the machine's state implies.
  enroll: {
    body: "Register this machine again — with a different control plane, or as a new node.",
    notes: () => {
      const current = probe?.status?.nodeId;
      const where = probe?.status?.serverUrl;
      const lead = current
        ? `This machine is already enrolled as node ${current}${where ? ` on ${where}` : ""}. Enrolling again ` +
          "overwrites that configuration, registers a SECOND node on the control plane, and discards the current " +
          "node key — whose only copy is that file. The old node row stays behind and has to be deleted by hand."
        : "This machine already has a node configuration. Enrolling again replaces it.";
      return [lead, ...ENROLL_NOTES];
    },
    form: true,
    actions: () => [
      ["Enroll this machine", doEnroll, false, "danger"],
      ["Cancel", cancelEnroll],
    ],
    hint: () => tmuxHint(probe, "enroll"),
  },

  "no-service": {
    body: "This machine is registered, but nothing keeps its agent running.",
    notes: [
      "Running it in the background writes a user-level service definition — a systemd user unit on Linux, a " +
        "launchd agent on macOS — that starts the agent at login and brings it back if it exits.",
    ],
    actions: () => [
      ["Run automatically in the background", service("install", { settle: true }), true],
      ...pathActions(),
      ...reenrollAction(),
    ],
    hint: () => tmuxHint(probe, "service"),
  },

  stopped: {
    body: "The background service is installed, but the agent is not running.",
    actions: () => [
      ["Start", service("start", { settle: true }), true],
      ["Uninstall the service", doUninstall],
      ...rewriteAction(),
      ...pathActions(),
      ...reenrollAction(),
    ],
    hint: () => tmuxHint(probe, "service"),
  },

  offline: {
    body: "The service manager reports the agent as running, but no local daemon is heartbeating.",
    notes: [
      "An agent that starts, fails and is restarted on a timer looks exactly like this. Its own log says why — a " +
        "missing tmux, an unreachable control plane, or a node key the server no longer recognises.",
    ],
    actions: () => [
      ["Restart", doRestart, true],
      ["Stop", doStop],
      // Reachable from here too: a crash-looping agent is exactly the case
      // where someone wants the supervision off while they investigate.
      ["Uninstall the service", doUninstall],
      ...rewriteAction(),
      ...pathActions(),
      ...reenrollAction(),
    ],
    hint: () => probe?.paths?.agentLogHint ?? "",
  },

  online: {
    body: "This machine is registered and its agent is online. Sessions can be launched here from the browser.",
    actions: () => [
      ["Restart", doRestart],
      ["Stop", doStop],
      ["Uninstall the service", doUninstall],
      ...rewriteAction(),
      ...pathActions(),
      ...reenrollAction(),
    ],
    hint: () => tmuxHint(probe, "service"),
  },
});

/** What to show before the first probe lands, or for a step this build predates. */
function fallbackStep() {
  return probe === null
    ? { body: "Checking this machine…", actions: () => [] }
    : {
        body: `This app does not know what to do about "${probe.step}".`,
        hint: "That usually means the app is older than the agent it is managing.",
        actions: () => [["Retry", act(null), true]],
      };
}

const stepKey = () => override ?? probe?.step ?? null;

function renderStep() {
  const key = stepKey();
  const step = (key !== null && STEPS[key]) || fallbackStep();
  const card = el("step-card");
  const actions = el("step-actions");

  // Body and hint are recomputed every render: both read live probe facts
  // (tmux, the log hint) that can change under an unchanged step.
  el("step-body").textContent = text(step.body);
  el("step-hint").textContent = text(step.hint);

  // The upgrade offer rides alongside whatever step is showing, so it belongs
  // in the rebuild key: a probe that newly discovers a newer bundled agent has
  // to be able to add the button without the step itself changing.
  const rebuildKey = `${key}|${probe?.agentChoice ?? ""}|${prefs?.agentBinPath ?? ""}`;
  if (renderedStep !== rebuildKey) {
    renderedStep = rebuildKey;

    const notes = el("step-notes");
    notes.textContent = "";
    for (const line of list(step.notes)) notes.append(paragraph(line, "note"));

    const formHost = el("step-form");
    formHost.textContent = "";
    fieldNotes.server = null;
    fieldNotes.key = null;
    fieldNotes.name = null;
    if (step.form) {
      formHost.append(buildEnrollForm());
      renderFieldNotes();
    }

    actions.textContent = "";
    // A newer bundled agent is OFFERED alongside the current step — never
    // applied unasked, because installing it stops the service that runs the
    // old one. The reverse (a newer agent already installed) is adopted
    // silently and is not a choice.
    //
    // Not on the re-enroll screen: that row already ends in a destructive
    // button, and putting an unrelated one first is how the wrong one gets
    // clicked.
    if (probe?.agentChoice === "upgrade-available" && key !== "enroll") {
      actions.append(button(`Update the agent to ${probe.bundledVersion}`, doUpdateAgent, false));
    }
    for (const [label, handler, primary, extra] of step.actions()) {
      actions.append(button(label, handler, primary, extra));
    }
  }

  for (const b of card.querySelectorAll("button")) b.disabled = busy;
  for (const i of card.querySelectorAll("input")) i.disabled = busy;
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

/**
 * Raise a confirmation the user has to accept before anything runs.
 *
 * In the page rather than in a native dialog on purpose, and not only because
 * `capabilities/main.json` grants `dialog:allow-open` and
 * `dialog:allow-message` but no `ask`: these messages are several sentences of
 * consequence — what a spent setup key costs, which subshells a restart kills
 * — and a modal that has to be dismissed to re-read the form behind it is the
 * wrong shape for that.
 */
function ask(spec) {
  pendingSeq += 1;
  pending = { ...spec, key: pendingSeq };
}

function renderConfirm() {
  const host = el("confirm");
  const key = pending?.key ?? null;
  if (renderedPending === key) return;
  renderedPending = key;
  host.textContent = "";
  if (pending === null) return;

  const box = document.createElement("div");
  box.className = "confirm";
  box.append(paragraph(pending.title, "confirm-title"));
  for (const message of pending.messages) box.append(paragraph(message, "note"));
  const row = document.createElement("div");
  row.className = "actions";
  row.append(button(pending.acceptLabel, acceptPending, false, "danger"));
  row.append(button("Cancel", cancelPending));
  box.append(row);
  host.append(box);
}

/**
 * Run the pending confirmation's action.
 *
 * Captured BEFORE {@link guard} runs, because `guard` clears `pending` on entry
 * — which is what stops a confirmation raised for one set of arguments from
 * lingering over a later, different action.
 */
function acceptPending() {
  const spec = pending;
  if (spec === null || busy) return;
  void guard(() => spec.run())();
}

function cancelPending() {
  if (busy) return;
  pending = null;
  render();
}

// ---------------------------------------------------------------------------
// The render loop
// ---------------------------------------------------------------------------

function renderPrefs() {
  const card = el("prefs-card");
  const supported = prefs?.traySupported === true;
  card.hidden = !supported;
  if (!supported) return;
  const box = el("close-to-tray");
  box.checked = prefs.closeToTray === true;
  box.disabled = busy;
}

function render() {
  renderChip({ probe, busy });
  renderFacts({ probe, prefs, enrolledNode });
  el("problem").textContent = problem;
  // Confirmations BEFORE the step: the panel lives inside the step card, and
  // `renderStep` is what disables everything in that card while busy. Built
  // after it, a fresh "Restart anyway" button would come up clickable
  // mid-action.
  renderConfirm();
  renderStep();
  renderPrefs();
}

async function refresh() {
  probe = await invoke("node_probe");
  // The Rust side reports the CLI's own failure text rather than letting a
  // failed `status` masquerade as an unregistered machine.
  problem = probe.error ?? "";
  prefs = await invoke("node_settings");
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
    pending = null;
    show(null);
    render();
    try {
      const result = await fn();
      if (result) show(result);
      // A refusal that raised its own confirmation is explained by that panel;
      // saying "that did not work" over the top of it reads as a dead end.
      if (result && result.ok === false && pending === null) {
        problem = "That did not work — see the output below.";
      }
    } catch (err) {
      // A command that rejects (or a Rust `Err`) must not strand the window.
      // These messages are actionable sentences — on Linux, "open the agent
      // log" rejects with the `journalctl` command to run instead.
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

/**
 * Wait for the daemon to take the lock after the manager returns.
 *
 * `service start` returns as soon as systemd/launchd has spawned the process;
 * the daemon writes `daemon.lock` a beat later. Without this, starting a
 * stopped node lands on "Offline" — which looks like a failure and invites a
 * restart that was never needed. Bounded to two extra probes: `node_probe` is
 * two CLI spawns plus ladder probes, so this is a settle, never a poll. (The
 * probe that a poll would be tempted to use, `status --probe`, is not merely
 * expensive: it supersede-kicks a live agent, possibly one on another machine
 * for this same node. The Rust side makes it unreachable.)
 */
async function settle() {
  for (let i = 0; i < 2 && probe?.step !== "online"; i += 1) {
    await sleep(1500);
    await refresh();
    render();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const act = (cmd, args) => guard(() => (cmd ? invoke(cmd, args) : null));

/**
 * One `service` verb. `force` is never passed here — the CLI accepts it only
 * on `restart`, and that one path goes through {@link doRestart} so its
 * refusal is read out loud before the override is offered.
 */
const service = (verb, opts = {}) =>
  guard(async () => {
    const result = await invoke("node_service", { verb, force: false });
    if (result.ok && opts.settle) await settle();
    return result;
  });

const openPath = (target) =>
  guard(async () => {
    await invoke("node_open_path", { target });
    return null;
  });

/** The Rust side validates the chosen file and returns an Err for anything that is not an agent. */
const pickBinary = guard(async () => {
  const chosen = await dialog().open({ multiple: false, directory: false, title: "Choose the subshell agent" });
  if (!chosen) return null;
  await invoke("node_set_agent_bin", { path: chosen });
  return { ok: true, stdout: `Using ${chosen}` };
});

const clearBinary = guard(async () => {
  await invoke("node_set_agent_bin", { path: null });
  return {
    ok: true,
    stdout: "Cleared. The app will resolve an agent again from the service definition, PATH, or its own install.",
  };
});

/**
 * Replacing the installed agent stops the service that runs it — and does not
 * start it again. On a stale definition, stopping is also what ends every live
 * subshell. Neither is something to do on a single click.
 */
const doUpdateAgent = guard(() => {
  const messages = [
    `Install the agent that ships inside this app (${probe?.bundledVersion ?? "unknown version"}) over ` +
      "~/.local/bin/subshell. Nothing is downloaded.",
  ];
  if (probe?.managed === true) {
    messages.push(
      "The service is stopped first so the file can be replaced, and is NOT started again — start it from here " +
        "afterwards.",
    );
    if (paneRisk(probe)) {
      messages.push(
        "The installed definition does not spare live panes, so stopping it kills every subshell running on this " +
          "machine.",
      );
    }
  }
  ask({
    title: "Update the agent",
    messages,
    acceptLabel: "Update the agent",
    run: () => invoke("node_install_agent"),
  });
  return null;
});

/**
 * Register this machine.
 *
 * The two-call flow the Rust side defines: `confirm:false` first, and when it
 * comes back asking, NOTHING was spawned and no key was spent — so the reasons
 * are shown and the identical arguments are re-sent only on an explicit
 * acceptance. There is no auto-retry anywhere in here: once the control plane
 * has accepted a key, a second attempt with it cannot succeed, and the CLI's
 * own stderr already says to mint a new one where that is the answer.
 */
const doEnroll = guard(async () => {
  const { invalid, args } = validateEnroll();
  if (invalid) return null;
  const outcome = await invoke("node_enroll", { ...args, confirm: false });
  if (!outcome.requiresConfirmation) return finishEnroll(outcome);
  ask({
    title: "Confirm before this setup key is spent",
    messages: outcome.confirmations.map((c) => c.message),
    acceptLabel: "Enroll this machine",
    run: async () => finishEnroll(await invoke("node_enroll", { ...args, confirm: true })),
  });
  return null;
});

function finishEnroll(outcome) {
  if (outcome.ok) {
    enrolledNode = outcome.node;
    // The key is spent either way, but a consumed credential has no business
    // sitting in a field where the next click could re-send it.
    form.key = "";
    form.name = "";
    override = null;
    renderedStep = null;
  }
  return outcome;
}

/**
 * Restart, and offer `--force` only for the refusal `--force` can answer.
 *
 * The one place this file reads the CLI's prose, and the reason is that
 * nothing structured says "refused": the pane guard's refusal and a masked
 * unit, a dead D-Bus or a permission error all arrive as the same non-zero
 * exit. Deciding from `paneSafety` instead would offer "restart anyway" for
 * all four — and `--force` helps only the first, so the other three would then
 * fail a second time. The override is a separate, named button behind the
 * verbatim refusal, never a silent retry.
 */
const doRestart = guard(async () => {
  const first = await invoke("node_service", { verb: "restart", force: false });
  if (first.ok) {
    await settle();
    return first;
  }
  if (!first.stderr.includes("refusing to restart")) return first;
  ask({
    title: "This restart would kill every subshell running on this machine",
    messages: [
      first.stderr.trim(),
      'The button labelled "Rewrite the service definition" is the CLI\'s own first suggestion: it fixes this for ' +
        "good and kills nothing. Forcing the restart loses every session running on this machine right now.",
    ],
    acceptLabel: "Restart anyway (--force)",
    run: async () => {
      const forced = await invoke("node_service", { verb: "restart", force: true });
      if (forced.ok) await settle();
      return forced;
    },
  });
  return first;
});

/** Stop warns rather than refusing, so the CLI's warning is the thing to surface. */
const doStop = guard(() => invoke("node_service", { verb: "stop", force: false }));

/**
 * Uninstalling gates on nothing in the CLI — deliberately, so a stranded unit
 * can always come down. That makes this the one place the consequence gets
 * said out loud.
 */
const doUninstall = guard(() => {
  const messages = [
    "The agent stops and will not come back at login. This machine stays registered — its configuration and node " +
      "key are untouched — so running it in the background again is all it takes to bring it back.",
  ];
  if (paneRisk(probe)) {
    messages.push(
      "The installed definition does not spare live panes, so this kills every subshell running on this machine.",
    );
  }
  ask({
    title: "Uninstall the background service",
    messages,
    acceptLabel: "Uninstall the service",
    run: () => invoke("node_service", { verb: "uninstall", force: false }),
  });
  return null;
});

function showEnroll() {
  if (busy) return;
  // Seeded from the control plane this machine already answers to: the common
  // re-enroll is the same server with a fresh key, and re-typing a URL is
  // where a typo becomes a spent key.
  form.server = form.server || probe?.status?.serverUrl || "";
  override = "enroll";
  pending = null;
  render();
}

function cancelEnroll() {
  if (busy) return;
  override = null;
  fieldErrors.server = "";
  fieldErrors.key = "";
  fieldErrors.name = "";
  render();
}

/**
 * The tray preference, and why it is not always offered.
 *
 * On Linux `TrayIconEvent` is never emitted and a stock GNOME has no
 * StatusNotifier host, so the icon can be silently invisible — a window hidden
 * to an icon that is not there is unreachable, with nothing to explain it. The
 * Rust side reports whether the switch is safe to show and refuses to persist
 * `true` where it is not; this page just does not draw it. Not routed through
 * {@link guard}: a checkbox is not worth two CLI spawns.
 */
async function toggleTray() {
  try {
    await invoke("node_set_close_to_tray", { enabled: el("close-to-tray").checked });
    prefs = await invoke("node_settings");
  } catch (err) {
    problem = String(err?.message ?? err);
  }
  render();
}

el("refresh").addEventListener("click", act(null));
el("close-to-tray").addEventListener("change", toggleTray);
render();
void act(null)();
