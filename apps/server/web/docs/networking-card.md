# Networking: one card that is a state machine

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

`/settings/networking` and the first-run step both render ONE component,
`components/networking/network-plugin-card.tsx`, and that is deliberate: the
six states a network walks (`not-installed` → `daemon-down` →
`needs-privilege` → `needs-login` → `joined` → `published`, plus unsupported
and disabled, which short-circuit before any of them) are a sequence a person
passes once, and a second implementation of it would be a second place for
"what can I do from here" to be answered differently on two pages met minutes
apart. The wizard step passes `compact`, which changes the FRAME and never the
acts: it drops card chrome, the description, the supervisor line and every
non-required settings field, because hiding a required one would leave a
Connect button nothing on screen could satisfy.

**The page itself is two cards and a form, since 2026-09-17.** The
`AddressesCard` moved in from `/settings/service` (where this server listens
and which addresses a browser may use is the same question this page answers,
asked of config.env), so its 60 s `useServerDeployment` poll now feeds the
card alone (the card's save writes the fresh view into that cache itself,
which is why the cadence did not move with the card; the "This server's
address" summary line the read used to feed is GONE: the card states the
value in its field, saved-vs-running included), and the page mounts
`useServerRestart` + `useAdminStatus` for its restart half. Below it sits ONE
grouped **Networks** card holding the installed plugins as collapsed rows;
`NetworkRow`'s `full` prop became `body="compact"|"full"` because the group
drew the distinction the per-network card frame used to: two surfaces, one
flat row frame, different bodies. The card is UNCONDITIONAL: a failed
deployment read renders it with the failure and a Retry inside rather than
losing the page's main form, as it first did (review, 2026-09-17), and an
answered-empty networks list answers in place ("No networks installed yet");
`AddNetworkCard` below carries the install affordance.

Three rules the card keeps, each with a defect behind it:

- **The plugin owns its copy.** Hints, labels and step text render verbatim.
  What this page owns is the shape, and the consequences that are the SERVER's
  rather than the network's: what a non-secure-context address costs, that
`subshell-server backup` does not include a plugin secret. Publishing moves
  no boot-time identity and writes no config: the base URL is the Addresses
  card's field (that card moved onto THIS page from `/settings/service` on
  2026-09-17, the one config.env writer here, saving through the same
  `PATCH /api/admin/server/config` the Service page used to host it), and
  the server's allowlist is a LIVE registry: its own local
  origins ∪ the Addresses card's `TRUSTED_ORIGINS` extras (consulted on every
  request) ∪ every ENABLED network plugin's addresses (a `private` network
  from `joined` up; a `public-with-gate` one only while published). So a join
  to a tailnet is enough for a phone to sign in, a publish trusts its
  addresses the moment the plugin reports them, and an unpublish, a leave or a
  Disable takes back exactly what THAT act ends trusting, now, not at a
  restart (2026-09-16; the restart notice, `config-write-outcome.tsx` and the
  card's `useServerRestart` went with the config write they described): a
  gated unpublish its published set, a leave or a Disable everything the
  plugin held, and a private unpublish NOTHING: membership is what trusts a
  private network's addresses, so those stay until a leave or a Disable ends
  the membership (ruling R-D-lite v2: the wire's `origins` is that per-act
  diff, which is why the result line never overstates what stopped). For the
  implicit kind the JOIN is the publish: the join route records it and its
  `done` frame lands on `published`, which is what the card keys its
  announcement on. The result grammar is `lib/network-result-copy.ts`
  (outcome first, no key named, present tense only) pinned in
  `lib/__tests__/`. The card's Disable is `useSetPluginEnabled` from
  `use-instance-plugins.ts`, the same `PATCH /api/plugins/:id` Settings →
  Plugins toggles (the server unpublishes first and 409s if it cannot); it
  confirms only when there are addresses to name, and a disabled row collapses
  to one line plus Enable. The `compact` frame carries no Disable: first run
  is not where someone toggles plugins.
- **Nothing privileged is ever a button**, including the numbered install steps.
  Same rule as the wizard's tmux screen (`components/setup/tmux-step.tsx`):
  this server has no terminal to answer a password prompt. Numbering runs only
  over hints that carry a COMMAND, so a plugin's explanatory sentence is not
  rendered as an instruction to perform.
- **A refusal is an ANSWER.** A publish returning `ok:false` with a `refused`
  hint renders inline where the button was, with no alert role: the server
  worked correctly and said why not.

`hooks/use-network.ts` holds the query and six mutations; the three streaming
ones (install, join, publish) reuse `readInstallStream` from
`use-install-agent.ts` rather than a second NDJSON reader. Every act that
changes what is trusted (publish, unpublish, leave, and join) invalidates
`PUBLIC_SETTINGS_QUERY_KEY`, because `GET /api/settings/public → trustedOrigins`
is the effective allowlist and the mobile dialog and the setup checklist read
it; `useSetPluginEnabled` does the same, plus `NETWORK_QUERY_KEY`. Every act
goes through the card's `begin()`, which resets ALL the mutations: a result
outlives the state it describes, so a publish announcement survived the
unpublish that undid it until that was true.

`types/network.ts` is a HAND-WRITTEN mirror of `apps/server/api/src/api/network/schemas.ts`.
Elysia strips fields a schema does not declare, so a mismatch is silent in
exactly the way `lib/split-workspace-refusal.ts` records: check both when you
touch either.

**A network plugin must never be launchable.** Every picker filters
`type === "agent-harness"` positively rather than `!== "terminal"`
(`lib/subshell-compat.tsx`, and mobile's `lib/agent-default.ts`). That is the
whole type audit, and reverting either filter fails a test.

**The wizard's optional steps carry ONE primary button, and its label names
what the press actually IS** (operator's call, 2026-09-18): "Continue" only
when the step has something to continue with (a joined or published network
(`isNetworkUsable`, deliberately narrower than the `hasStarted` sort key: an
installed-but-signed-out daemon still leads the list and still says skip), or
a detected agent), and "Skip for now" otherwise. The network step used to
ship a ghost skip beside an unconditional Continue, two buttons for the one
`goNext` they both ran and a label that promised a continuation on a machine
joined to nothing. Unknown reads as the skip label, the OPPOSITE polarity
from `lib/node-enrollment.ts`, which defaults unknown to allowed: there an
unknown hid a control that works; here it would mislabel an action a failed
check cannot vouch for, and skipping must work exactly when the check cannot
speak. **The tmux step is not one of the optional steps: it GATES**
(operator's ruling, 2026-09-18, deliberately reversing spec 2026-09-15
§ 5.1's non-blocking choice): its button always reads "Continue" and stays
disabled until the admin-status read reports a `tmuxPath`, because skipping
tmux just moves the refusal from the step to the launch button without saving
anyone a step; a failed read therefore grows the body's ErrorBanner + Retry:
a gate with no way to answer is the trap § 5.1 was written to avoid, inverted.
The launch step keeps a real ghost Skip because there Skip and Start are
different acts, the one case where two buttons are honest.
