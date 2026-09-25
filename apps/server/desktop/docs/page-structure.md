# What the page is made of deep dive

The `ui/` tree, the lib-versus-screens split rule and the About panel: the
"What the page is made of" section, lifted verbatim from
`apps/server/desktop/AGENTS.md`. Read this before moving logic between
`lib/` and `screens/` or adding a screen module.

## What the page is made of

```
ui/
├── wizard.html         # the ONE Vite input; it loads /src/main.tsx (pinned by tauri-config.test.ts)
├── src/
│   ├── main.tsx        # the React entry: mounts <Host>
│   ├── host.tsx        # the state owner: probe + poll, route resolution, the screen listener,
│   │                   #   the update selection's overrides — the old wizard.ts's role
│   ├── runners.ts      # the action layer: act, startSetup, startTmuxInstall, pickBinary,
│   │                   #   runRecovery, refreshTail — one hook over the host's state bag
│   ├── components/     # the app's UI primitives (button, badge, …)
│   ├── hooks/
│   │   └── use-port-check.ts  # the port-in-use round trip behind the setup gate
│   ├── screens/        # ONE component per screen, props in, never a reach into host.tsx;
│   │   │             #   the frame and its strings come from @internal/assistant
│   │   └── copy-button.tsx, address-fields.tsx, status-details.tsx   # shared blocks
│   ├── styles.css      # @theme tokens + component classes; Tailwind in markup
│   ├── lib/            # the pure decisions, testable without a webview
│   │   ├── ipc.ts            # one typed function per `desktop_*` command this page invokes
│   │   ├── wizard-state.ts   # screensFor, autoSetupDecision, recoveryTitle/Action, RESET_LABEL, the checklist
│   │   ├── server-state.ts   # railFor: which rail sections a route and an onboarded machine get
│   │   ├── config-form.ts    # the pure form contract (docs/ipc-boundary.md)
│   │   ├── installers.ts     # the pure install plans and manual routes
│   │   ├── recovery-model.ts # the recovery screen's subtitle, facts and pane risk
│   │   ├── update-act.ts     # the ONE update act: rows, phases, presses, refusals
│   │   ├── pane-force.ts     # the pane-safety Force box, shared by both screens that restart
│   │   ├── settings-screen.ts # Server Addresses: the https warning, what Save sends, its refusals
│   │   ├── permissions-model.ts # the three macOS rows: glyph, suffix, action, pane
│   │   ├── copy-flash.ts     # the Copy button's copied/failed state, by key and by clock
│   │   └── reset.ts          # the reset dialog's pure decisions: rows, refusal, arming
│   └── __tests__/      # pure pins (config-form, installers, wizard-state, recovery-model,
│                       #   update-act, settings-screen, permissions-model, copy-flash, reset,
│                       #   wire-names, ipc-acl, tauri-config) + component tests under
│                       #   screens/__tests__ (a real DOM via @testing-library, happy-dom
│                       #   preloaded by ui/bunfig.toml)
└── dist/               # `frontendDist` — built, gitignored, never hand-edited
```

The split rule the plain-JS version established still decides WHERE logic
lives: anything with a contract rather than a rendering goes in `lib/`, where
it is testable without a webview, and `screens/` holds only rendering.

Four things about that arrangement are load-bearing:

- **No screen imports `host.tsx`.** The host renders the screens and passes
  them what they need as props; a cycle back up to it is the same hazard the
  old page had: a module-eval dead zone reads as a BLANK window on the
  machine someone is repairing, not a type error. The old `AssistantHost`
  contract is the props lists now; navigation stayed out of them for the old
  reason (a screen that could navigate navigates a structure the host owns).
  The other boundary pin: Tauri is reached only through `lib/ipc.ts`.
- **The amber tmux gate is no longer a factory.** `tmux-warning.ts` had to be
  one because the imperative page built a single element that two gated
  surfaces re-appended, and one created per render threw away a half-finished
  Copy. React deleted the mechanism: `status-screen.tsx` renders its gate
  block itself. The Copy button keeps its own entry below because its flash
  is still state the render does not own.
- **A Copy button's flash is PAGE state** (`lib/copy-flash.ts`), which is the
  third time this app has had to move something out of an element the render
  rebuilds (after `Show Details` and the reset screen's step rows). The flash
  lasts 1600 ms and the poll renders every 1500, so a tick living in the
  element survived a uniformly random 0–1500 ms of it: pressed, seen, gone,
  with nothing wrong and nothing to notice. The slot is keyed by a string the
  CALLER owns (the element is the thing that does not survive), and expires
  by TIMESTAMP rather than by a timer having fired, since the timer belongs to
  whichever button has already been discarded. Copy buttons are also the one
  affordance here that is never disabled, and by construction rather than by
  an opt-out: they are not built through the screens' busy-disabling pattern
  (`screens/copy-button.tsx`). (A `data-always` opt-out existed for the
  console's sweep, which read it; the sweep went with the console and the
  attribute outlived its only reader by three months.)
- **`lib/update-act.ts` holds every judgment the update screen makes**, for
  the same reason and with a sharper edge: the screen has six phases, two
  presses and four sentences it refuses in (a server this app did not
  install, one NEWER than the bundle, a release source that would not answer,
  and the automatic attempts being spent), never more than two of them at once,
  since a phase-2 screen returns before the release answer is consulted. None
  of it could be covered at all from inside the component. Which rows appear,
  which of them carry a checkbox and which carry a reason instead, what is
  ticked by default, whether the Force box renders, what the press is called
  and what it will do, and whether phase 2 fires by itself are all decisions
  there, and `update-act.test.ts` walks § 4.1's four cases, § 4.2's two phases,
  § 13's selection and each of § 6's refusals. The SELECTION itself is page
  state in `host.tsx` (held as overrides, so an absent id is the model's
  default and a tick made against a row that stops existing takes nothing with
  it), because the model is pure and is handed the answer rather than keeping
  it.
- **`lib/recovery-model.ts` exists so the recovery screen's WORDS are
  testable.** Its subtitle and its facts were the console's step table and
  Details list: DOM, in a render that needs a webview, which is why neither
  was ever covered. They are data now, and `recovery-model.test.ts` covers the
  rows that only appear when something is wrong: an unresolved MCP entrypoint,
  a port answering while the service is not running, a teardown that kills
  live panes, a manager that would not answer.

**About is native now, and it owns no strings of its own** (spec 2026-09-17
§ 6). The predefined About item rides the macOS app menu; Linux, which has no
app menu, gives the DASHBOARD window a one-item menu bar carrying the same
item; muda's GTK backend renders a real `AboutDialog` from the metadata, so
the panel is not macOS-only chrome. Both read one `about::metadata()`
assembly: a pure function under test, fed the version from `PackageInfo`
(NOT `env!("CARGO_PKG_VERSION")`, which is the crate's 0.1.0; the real
version reaches it through `tauri.conf.json` reading `../package.json`), and
the copyright, licence summary and URLs from the same
`crates/desktop-core/src/legal.rs` constants `scripts/license-fields.ts`
holds equal to the TypeScript copy and the root `LICENSE`. A third copy in
`ui/src` would still be the one the detector cannot see. The Status section
keeps exactly ONE fact from the old block: `This app — Subshell Server {version}`,
because the version belongs beside the log text a person is
about to paste into a bug report; wave 2 renders it INLINE in that section
(the Show Details disclosure is gone), and `desktop_about` keeps that line
as its last caller.
Distinct from the SPA's own `AboutDialog` (user menu → About), which is about
the product and the SERVER build: this panel is about the app binary, and it
is the only surface that knows the app's version.

**That is also why the native panel needs no command at all.** It is built in
Rust from the same constants (no `desktop_about` round trip, no URL crossing
the IPC boundary in either direction). And on a machine whose server is DOWN,
where the SPA's About dialog is unreachable, the panel is still there, which
is precisely the machine this page exists for.
