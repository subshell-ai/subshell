# Design: Subshell Client's first run asks what you came to do, then registers in one press

Date: 2026-09-18
Status: **v1 building** (plan: `docs/superpowers/plans/2026-09-18-client-first-run-experience.md`),
**two pieces deferred.** The operator first called for a simpler MVP, then (2026-09-18)
pulled the cut items back in — so v1 is this flow in full, EXCEPT:
(1) **background-vs-run-with-the-app node supervision** — v1's start-up screen offers the
service with a **start-at-login** choice only; the *run the node as the app's child* mode is
deferred because the client has no `supervisor.rs` and a node's tmux-server children make
the signal discipline its own design (§ 7's tmux install, not the server's app-child
supervisor, is what v1 shares). (2) the **client dashboard with a saved-server list /
multi-window** (§ 11) stays ice — web and mobile cover the richer surfaces. The load-bearing
rule from here regardless: **never open the dashboard in-app during setup; a configured
client lands on the client-status screen, and the dashboard opens only from a button.**
— written as a proposed design on 2026-09-18 from the operator's direction:
"opening the server should not be the first-run action; the FTE should ask the
user what they want to do — register the machine as a node, or just connect to a
server dashboard"; "the setup screen should ask for the server URL, node name,
and setup key, with the button saying 'Register'"; "no need to confirm, it should
be assumed the key is consumed once registered"; "it should have the tmux install
step like the server because it is required"; "if using the machine as a node, we
should still have the ability to connect to the server dashboard once registered."
Supersedes: the client node-window first run of
`2026-09-12-management-in-the-dashboard-design.md` § 6.4 and its inventory in
`apps/client/desktop/AGENTS.md` — specifically, the seven-screen probe machine
(`connect` / `install-agent` / `enroll` / `service` / `connected` / `reset` /
`about`) is now an **overlay for a true first run**, not the whole window. Leaves
in force: the assistant frame (`2026-09-11-first-run-second-pass-design.md` § 3),
the probe model and every `node_*` command's own contract, the reset chain, the
two-window trust boundary (the `main` window's single pinned remote origin,
`capabilities/main.json`), and `apps/client/desktop/AGENTS.md`'s rule that the
node window existing is the whole "node functionality" toggle.

Companion plan: `docs/superpowers/plans/2026-09-18-client-first-run-experience.md`
(to be written after this spec is approved).

Deferred sibling: `2026-09-18` decision recorded in § 11 — a dedicated **client
dashboard** with a saved-server list, and eventual **simultaneous multi-server
windows**, are their own spec. This one ships the first run only.

## 1. The problem

Subshell Client is two things in one window set, and the first run conflates
them. `main` shows a control plane's own dashboard; the bundled `node` window is
this machine's registration assistant. A fresh install (or one after
`bun run reset:client`) lands on the assistant's **Connect** screen, whose one
primary button is labelled **"Open"** and whose only copy is: *"Opening a server
does not register this machine. Enrolling comes after, and only if you want
subshells to run here."*

Pressing it persists `planeUrl` and opens the dashboard window (`node_open_plane`
persists, then `windows::open_plane` — control.rs:1320-1321). So a person who has
just installed the app and is trying to **set it up** gets, as the headline
action, a jump to a dashboard, while the setup continues in the window behind it.
That is the bug that prompted this design (operator, 2026-09-18: "enter a url, it
opens the dashboard. but it stays on this screen even after entering the
address."). The screen is technically correct — it advances to *Install the
Agent* — but its primary verb belongs to the *watch* use case while the window is
being used for the *register* use case.

The deeper defect is that the first run **never asks which use case the person is
in**. There are two real ones and the flow assumes the second:

- **Watch** — "point this app at my server's dashboard." This is the person AGENTS
  describes as a client that never enrolls. For them, connecting *is* the job.
- **Register** — "run subshells on this machine." For them the machine must install
  tmux, install the agent, enroll with a setup key, and start a service — and
  *then* they want the server's dashboard too.

Today the first run serves neither cleanly: it does the watch action on the button
a registering user presses, and buries the register path three probe-derived
screens deep (`install-agent` → `enroll` → `service`), each its own press, the
enroll one gated behind a tmux check that only disables a button and prints a
hint. There is no tmux *install* step in the client at all — unlike Subshell
Server, which installs tmux for you (`desktop_install_tmux`).

## 2. The rule

**The first run asks what you came to do, then does that one thing well:**

1. If you came to **register this machine**, the first run is a straight line to a
   working node — tmux, then one **Register** screen that installs the agent,
   enrolls, and starts the service — and the server's dashboard is one button away
   when it's done, not before. **tmux is a hard requirement, not a step you can walk
   past:** every subshell runs in a tmux pane, so there is no path to a registration —
   and no press of **Register** — while the probe finds none (operator, 2026-09-18:
   "tmux is REQUIRED to proceed with a node registration"). The client installs it for
   you where it safely can (§ 7) and otherwise shows the command and waits.
2. If you came to **watch a server**, the first run connects and opens its
   dashboard, and does not spend a key or touch this machine.
3. **Nothing in the register path opens the server's dashboard.** The dashboard
   appears only from the connected screen's own button (which already exists), or
   from the watch path. The two windows keep their boundary (§ 10); the first run
   stops blurring it.

The frame, the probe, the commands, the reset, and the trust boundary are
unchanged. What changes is the **front door** and how the existing pieces are
sequenced.

## 3. Scope

**In:** the first-run flow for a machine with nothing yet set up (§ 4-5); the
`Register` action that chains install → enroll → service (§ 6); the **Setting Up…**
process screen that shows that chain (§ 5.6); a `node_install_tmux` command for tmux
parity (§ 7); the routing that keeps the existing screens for day-2 recovery (§ 5.4);
tests (§ 9).

**Out (see § 11):** a new client dashboard surface; a saved list of many servers;
simultaneous multi-server windows (a trust-model change to `PlanePin`/capabilities);
any change to how many control planes a node may be enrolled to — **the node still
enrolls to exactly one** (`config.json` dials one `serverUrl`); any change to the
watching-vs-enrolling distinction itself.

## 4. The flow

```
             (fresh: no planeUrl, no agent, no node config)
                            Welcome   "Welcome to Subshell Client"
                               │ Continue
                               ▼
                            Choice    "What would you like to do?"
          ┌─────────────────────┴──────────────────────┐
   Use this machine as a node                  Connect to a server
          │                                          │
     tmux? (only if missing)                    Server URL · Connect
          │ auto-advances once found                 │
          ▼                                          ▼
     Register (server URL · name · setup key)   server dashboard opens in
          │ Register (no confirm)               `main` · Connected-to-X:
          ▼                                     [Open dashboard] ·
     Setting Up…  (progress checklist)          [Set up this machine as a node]
       Install agent → Enroll → Start service
          │ rows tick from the probe; on failure the row names the act
          ▼ Continue  (handoff)
     Connected  (existing screen)
       primary "Open <server> dashboard" · More… update / re-enroll / reset
```

- **Welcome** — wordmark, one sentence naming both halves of the app
  ("connect to a Subshell server, and optionally run subshells on this machine"),
  and **Continue** as the only control. Mirrors Subshell Server's `renderWelcome`
  shape (wordmark + one line + Continue) so the two apps read as one product. It
  touches nothing on the machine; the press only steps forward.
- **Choice** — the two use cases, as two buttons on one screen. This is the screen
  the old Connect screen refused to be.
- **Node path** → § 5.2 and the setup-process screen at § 5.6.
- **Watch path** → § 5.3.

## 5. Screens and routing

The first run is a **mode over the existing screen machine**, not a replacement of
it. `screenFor` (node-assistant-state.ts) gains a first-run front-gate.

### 5.1 Entering first-run mode

`firstRun` is true exactly when the machine is untouched: **no `planeUrl`
resolved, no agent binary on the resolution ladder, and no node config.** That is
"nothing yet," and it is the only state that shows Welcome and Choice. It is
computed from facts already on the probe + settings; no new stored flag is needed.

### 5.2 The register path

Once the person chooses *Use this machine as a node*:

1. **tmux** (shown only while `probe.tmux` is `null`, exactly as Subshell Server's
   `renderTmux` gates it): title "Install tmux", one line ("Every subshell runs in
   a tmux pane, so this machine needs it before it can run one."), a primary button
   that runs `node_install_tmux` (§ 7), and — because the tmux step is the one place
   a package manager may need a password the app cannot answer — the install command
   shown as a fallback with "Your package manager may ask for your password." When
   the probe next sees a tmux, the screen leaves on its own and Register appears.
   Nothing else in the flow can proceed without tmux, so this is a hard gate with a
   remedy, not a caption.
2. **Register** — server URL, node name, setup key in one screen. Reuses
   `EnrollFields` and `useEnrollForm`, which already collect and validate exactly
   these three (`validateEnroll` → `{server, key, name}`). The **Register** button is
   disabled until all three are non-empty and tmux is present (a button that only
   produces a refusal teaches people to click through warnings). The requirement is
   enforced twice: `subshell enroll` preflights tmux **before** its network call (AGENTS
   — precisely so an unenrollable box does not burn a one-time setup key), so a bypassed
   UI gate still could not register without tmux or spend a key on it. Below the fields,
   the loopback note (§ 6.3) when the URL points at `localhost`.
3. **Setting Up…** — pressing **Register** steps to a **process screen** (§ 5.6), like
   Subshell Server's `renderProgress`, that runs the chain (§ 6: install agent if needed →
   enroll → start service) and shows each act ticking. It does **not** land on Connected
   straight from the form, and it does not dump raw output under the fields.
4. **Handoff → Connected** — when every row is done, the completed checklist holds with a
   **Continue** (the server's `renderHandoff`), which steps to the existing **Connected**
   screen; its primary button opens the dashboard of the server just registered to — the
   operator's "once registered, still connect to the server dashboard."

### 5.3 The watch path

**Connect to a server dashboard** → one Server-URL field + **Connect**. It calls the
existing `node_open_plane` (persist + open the `main` window) and, on success, shows a
small **Connected-to-`<server>`** state in the node window with **Open dashboard**
(re-open) and **Set up this machine as a node instead** (step into the node path at
its first step, tmux/Register). No agent, no config, no key touched. The `Open in
browser` affordance is dropped from the first run entirely (operator: "we should NOT
have an 'open in browser' link"). It remains available later on the Connected screen's
More…, which is out of first-run scope.

### 5.4 Day-2 states keep the existing screens

First-run mode is only for `firstRun`. Once a machine is enrolled, or a server is
connected, `screenFor` routes by the probe as today:

- **connected** — the working node (unchanged; its More… still holds update /
  re-enroll / reset / change-server / open-in-browser).
- **service** — a stopped/offline/no-service agent on an already-enrolled machine
  (unchanged recovery screen).
- **not-enrolled (no config), however reached** — lands on **Register**, whether it is
  the first run, or a watcher who chose "set up this machine as a node," or a resume
  after the agent installed but enroll stopped. Its chain folds the agent install in,
  so the registering person never meets the stepwise install-agent screen.
- **install-agent** — retained only for the day-2 repair where a config exists (the
  machine is enrolled) but the agent binary is gone: `no-agent` **with** a node config.
  That is a repair, not a first run, and it must not land on Register (which would
  re-enroll). It survives for that case only.
- **enroll** — retained solely as the **re-enrolment** screen reached from
  Connected's More… (config exists; it warns that enrolling again mints a second node
  and discards the key, and its confirmation stays — § 6.2). It is never the landing for
  an unconfigured machine; **Register** is.

So the first-run chain does not delete any command or recovery screen; it removes the
*Connect* screen (absorbed into the watch path) and the *stepwise* not-enrolled path
(merged into Register), and adds Welcome / Choice / tmux / Register / **Setting Up…** (§ 5.6).

### 5.5 Resume mid-first-run

A first run abandoned and reopened, by what actually moved on disk:

- **Only tmux installed** (no `planeUrl`, no agent, no config): `firstRun` is *still
  true* — tmux is not this app's state — so it restarts at Welcome and re-walks, the
  tmux step auto-skipping because tmux now exists. Nothing else was persisted, so
  there is nothing to resume and nothing to lose.
- **Connected as a watcher**: `planeUrl` is set, `firstRun` is false, and
  `open_at_startup` leads with the dashboard (today's behaviour), the node window still
  openable.
- **Reached Register and the chain installed the agent (or enrolled) then stopped**: an
  agent/config fact has moved, `firstRun` is false, and the probe routes the rest —
  not-enrolled lands on **Register** (its chain re-runs the install as a no-op),
  enrolled lands on **Connected**. The node path resumes at a coherent screen rather
  than a half-told story.

The in-session Choice is deliberately **not persisted**: at most a tmux-only abandon
costs one re-pick, and persisting a choice the probe can already re-derive would be a
second source of truth for one fact.

### 5.6 The setup-process screen (Setting Up…)

Pressing **Register** does not land on Connected directly and does not dump output under
the form — it steps to a **progress screen** mirroring Subshell Server's
`renderProgress` / `renderHandoff` (wizard.ts:907, 927):

- **Rows from the probe, not a fake meter.** The checklist names each act the chain
  performs — *Install the agent → `~/.local/bin/subshell`*, *Enroll this machine →
  `<server>`*, *Start the node service* — and each row's state (pending / active / done /
  failed) is **derived from the probe and the act in flight**, exactly as the server's
  `checklist(p, …)` reads the probe. The chain re-probes between acts (the runner already
  re-probes on settle), so rows tick as effects land rather than on a timer.
- **This closes a defect this repo already learned.** The server's reset path carries step
  rows because "a dead button lettered 'Resetting…' reads identically to a hang" (AGENTS,
  reset). A multi-act chain — install, a network enroll, a service start — is that same
  risk; the checklist is what makes "working" legible from "stuck."
- **A failure names the act that failed.** A failed act marks its row and shows that act's
  **verbatim CLI/Rust line** beneath it (the CLI owns the message). The other rows stand
  as they are, so the person sees how far it got. Retry re-runs the chain; done acts are
  no-ops, and enroll is not re-attempted once spent (§ 8).
- **The handoff holds the completed list.** When every row is done the checklist stays
  with a **Continue** — the server's `renderHandoff` ("the answer to 'what did that just
  do'") — then steps to **Connected**. Unlike the server's zero-touch auto-open, the
  client's handoff **always waits for the press**: a chain the person just started is owed
  the beat before the dashboard.

The rows are a pure module (`registerSteps`, beside `node-assistant-state.ts`) so they are
testable without a webview (§ 9).

## 6. The Register action and the command contract

### 6.1 One press, three steps

`register()` (new, `use-node-commands.ts`) chains, through the existing serializing
runner, reusing the existing commands rather than re-spelling them:

1. **install the agent** if `probe.step === "no-agent"` — `node_install_agent`, which
   already takes no confirmation (it is "only ever offered where nothing exists to
   overwrite," install-agent-screen.tsx). A no-op when the agent is present.
2. **enroll** — `node_enroll({...fields, confirm: true})` **directly** (§ 6.2).
3. **start the service** — `node_service({verb: "install"})` then `runner.settle()` so
   the daemon's lock is observed before advancing (the settle already used by
   service start, use-action-runner.ts:139).

Each act feeds the **Setting Up…** screen's row (§ 5.6); a failure stops the chain and
marks that row with the act's verbatim CLI/Rust line (property 1 of use-node-commands:
the CLI owns the message). A chain that fails at enroll after the agent installed leaves
the agent in place — honest, and retry from the same screen converges. The runner
re-probes on settle, so a fully-completed chain reaches the handoff (→ Connected) and a
partial one stays on the checklist naming where it stopped.

### 6.2 No confirmation to spend the key — but only on the first register

Operator: "no need to confirm, it should be assumed the key is consumed once
registered." The Register press **is** the consent: the person typed a single-use key
into a field labelled as one and pressed **Register**, so `node_enroll` is called with
`confirm: true` immediately and `requiresConfirmation` is not surfaced as a dialog on
this path.

This is **scoped to the first-run Register**. **Re-enrolling** from Connected's More…
keeps its confirmation: it overwrites `config.json`, mints a *second* node row, and
discards the only copy of the current node key (enroll-screen.tsx, AGENTS "enroll has
no already-enrolled guard"). That is a different, destructive act on a working machine
and stays two-phase. The `use-node-commands.enroll()` re-enroll path is unchanged;
`register()` is a new, first-run-only sibling that skips the confirm.

### 6.3 The loopback footgun stays visible

`http://localhost:3080` — the address in the session that surfaced this — is the exact
case AGENTS' "enroll-time loopback trap" warns about: a node pointed at loopback dials
a control plane on *its own* machine, "online" against the wrong box if the URL was
copied from elsewhere. Removing the confirmation must not silence that. On the
Register screen it is an **inline `detail` warning** under the URL field (the same
sentence the Connected screen already shows, connected-screen.tsx:186-190), shown
live as the address is typed — one honest line, not a dialog, and not a blocker.

## 7. `node_install_tmux` (new command, tmux parity)

The client can detect tmux (`which("tmux")`) but cannot install it; Subshell Server
can (`desktop_install_tmux`). To make the tmux step behave "like the server," the client
gains a `node_install_tmux`:

- **Share the installer, don't copy it.** If `desktop_install_tmux`'s logic is not
  already in `crates/desktop-core`, lift it there and have both apps call it — this is
  exactly the class of thing desktop-core exists for (AGENTS: "do not re-implement…
  the shared halves"). A test pins the argv table.
- **Same trust class, same limits.** It is a local, admin's-own-machine act of the same
  kind the server's already is: it runs the platform package manager's tmux install with
  **no operator input**, and it **refuses any sudo-prefixed command before anything
  runs** — the server rule (AGENTS, `POST /api/setup/tmux/install`: every Linux entry is
  sudo-prefixed and refused; in practice it runs only under Homebrew on macOS). The
  tmux screen then shows the command for the human to run on those platforms.
- **New command = new ACL.** `permissions/desktop.toml` gains `allow-node-install-tmux`
  → `commands.allow = ["node_install_tmux"]`; `capabilities/node.json` grants it to the
  `node` window only; `ipc.ts` gains the typed wrapper; and `ipc-acl.test.ts` — which
  pins the granted set to the invoked set in all three files — must be updated in the
  same change or it names the one that was missed.

## 8. Error handling

- **Register chain failure** at any act → that act's verbatim line on its **Setting Up…**
  row (§ 5.6); the runner's re-probe routes the machine to the true state. No silent partial.
- **Enroll refused after the key was spent** (409 name taken, 500): show the CLI's
  words; a taken name is fixed by a different name, so preserve the name and clear the
  key (reuse `clearSpentKey`, use-enroll-form.ts) and say "mint a new setup key." Never
  retry the same key (no auto-retry anywhere — property the runner already enforces).
- **tmux install refused** (Linux sudo) → the command to run, and the gate holds until
  tmux exists.
- **Watch-path bad URL** → `node_open_plane`'s own rejection surfaces on the field.

## 9. Testing

- **Pure routing** (`node-assistant-state.test.ts`): `firstRun` detection;
  welcome→choice→(tmux|register) and welcome→choice→connect; tmux gating; and every
  § 5.5 resume case. This is the bulk of the risk and it is all testable without a
  webview.
- **`register()` chain** (`use-node-commands` test, mocked ipc): install-then-enroll-then-
  service when no-agent; skip-install when present; enroll called with `confirm:true`
  and no confirmation surfaced; a failing step stops the chain and re-probes.
- **`ipc-acl.test.ts`**: `allow-node-install-tmux` in all three files; `register`'s and
  `node_install_tmux`'s command names pinned; re-enroll still routes through the
  confirmed `enroll`.
- **Re-enroll keeps its confirmation**: assert `use-node-commands.enroll()` (the re-enroll
  path) still raises `requiresConfirmation` while `register()` does not.
- **Design**: `lint:design`, `no-inline-styles`, `switch-csp` (new screens reuse the
  existing primitives and classes).
- **Rust**: `node_install_tmux` argv/sudo-refusal tests in desktop-core; `cargo fmt`/
  `clippy -D warnings`/`test` via `bun run rust:check`.
- **Manual smoke** (dev, throwaway instance per root AGENTS — never `:3080`): fresh
  `reset:client` → walk both branches end to end; confirm no dashboard opens during the
  node path and Connected opens it after.

## 10. Trust boundary is untouched

The `main` window stays a single pinned remote origin with exactly one command
(`desktop_open_in_browser`); `capabilities/main.json` is unchanged. The new tmux command
is granted to the `node` window only, alongside the other `node_*` verbs. The register
chain spawns only `subshell` and the tmux installer through the existing bounded
`desktop_core::proc` (login PATH, deadline). Nothing here widens what any window may
invoke; it resequences existing grants and adds one privileged verb to the window that
already drives the CLI.

## 11. Deferred to a sibling spec (recorded decision)

The operator chose (2026-09-18, B) a dedicated **client dashboard** motivated by a future
of **connecting to several servers' dashboards**, then split it out. That surface — a
saved list of servers, opening a chosen one as a window, and ultimately **several
simultaneous server windows** — is a data-model change (`planeUrl` → `servers: []`) and,
for the multi-window half, a real change to the single-pinned-origin trust model
(`PlanePin`, `capabilities/main.json`, `docs/security.md`). It needs its own design and
security accounting.

This first-run spec is built so that sibling can land without rework: the node path
lands on the existing Connected screen now; that screen is precisely what the future
dashboard replaces (it already lists status + update + re-enroll + reset + open-server,
and its server list starts at length one). The node's enrollment stays one control plane
here and there; "many servers" is about *watching*, not *enrolling*.

## 12. Decisions log

- **Two use cases, branch at the FTE** (operator, replacing the initial
  "always-advance-past-connect"): first run asks *register* vs *connect*; both reach a
  server dashboard; only register touches this machine.
- **Dashboard = B (new surface), deferred** (operator): not a reframe of Connected; a
  real client dashboard, built later (§ 11). This spec lands on Connected meanwhile.
- **Register = whole chain in one press, no confirm** (operator Q2): install → enroll →
  service; press = key consumed. Confirmation kept **only** for re-enroll (§ 6.2).
- **tmux is REQUIRED to proceed with a node registration** (operator, 2026-09-18): a hard
  gate, not a skippable step — enforced twice (the Register screen disables without it,
  and `subshell enroll`'s own preflight refuses before the key is spent). It auto-installs
  like the server where safe via new `node_install_tmux` (sudo refused, command shown on
  Linux, § 7), and otherwise waits for tmux before advancing.
- **Loopback stays visible** (proposed, no objection): inline warning, not a dialog (§ 6.3).
- **No "open in browser" in the FTE** (operator): removed from first-run screens; stays
  on Connected's More… (post-FTE).
</content>
</invoke>
