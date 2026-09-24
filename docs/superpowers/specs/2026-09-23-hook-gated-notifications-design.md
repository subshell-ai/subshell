# Hook-gated notifications (2026-09-23)

## The problem

The bell rings "Done, waiting for you" every time the harness stops producing
output. That is wrong in three ways:

1. The injected `Stop` hook fires whenever the main loop ends its turn —
   **including when the session is merely parked waiting on a spawned
   subagent or a background task it will be woken by.** The push says "come
   back", and there is nothing to come back to.
2. The injected `Notification` hook carries **no matcher**, so every
   notification type — `idle_prompt`, `auth_success`, the
   `quota_auto_resume_*` family, `elicitation_complete` after the human has
   already answered — pushes "Needs your approval".
3. **One pane keeps pushing while the human has not looked.** A pane that
   pushed "waiting for you" rings again every turn until the user comes
   back — several lock-screen events for one unfinished visit.

The first two live in hooks that already exist and already carry the
distinguishing data; only the third touches the server (§1, §2, §3). No new
API surface and no wire-shape change anywhere.

## Decisions taken in the design conversation

- **No agent-side notify tool, no injected skill.** An MCP `notify_user` tool
  plus a pane-injected skill was designed and rejected: it spends the user's
  tokens to make notifications, and it adds a new self-report surface. The
  signal we need is already delivered to the hook for free (operator ruling
  2026-09-23).
- **The Stop push stays as the fallback.** A turn where the gating cannot
  answer still pushes. Wrong suppressions cost silence, which is worse than
  noise.
- **No non-pushing "still working" kind.** (Also decided before the pivot; it
  survives as a rejection — the gating makes the agent-side variant
  unnecessary.)
- **Suppression covers any running background task or scheduled cron**, not
  just waking types (operator ruling: accept that a never-ending background
  shell holds that turn's push until a later Stop finds the registry empty).
- **An unseen push silences its pane until the owner returns to it**,
  escalating only (operator ruling 2026-09-23): see §3.

## The mechanism

### 1. Stop gating in `packages/mcp-core/src/report.ts`

The `attention` verb with kind `turn_complete` reads the hook payload from
stdin — the same bounded 2 s reader the `session` verb already uses — and
applies one rule from the Claude Code hooks reference, which documents
`background_tasks` and `session_crons` precisely to "distinguish 'session is
done' from 'session is paused waiting for background work to wake it back
up'":

> Report nothing when the parsed Stop payload has a **non-empty
> `background_tasks` array or a non-empty `session_crons` array**.

Report-nothing means no POST, therefore no push **and no waiting stamp** — a
parked pane is not waiting for the human.

Everything else falls through to the POST exactly as today — the gate fails
**toward the push**:

| payload | behavior |
|---|---|
| `background_tasks` and `session_crons` both empty | push |
| either non-empty | no report |
| field absent (older Claude Code) | push |
| stdin empty / malformed / times out | push |
| payload is not JSON at all | push |
| kind `needs_attention` | push, and stdin is never read (the matcher, below, is its filter) |

The registry-unreachable caveat from the docs — a reachable-empty and an
unreachable registry both present as `[]` — resolves to a push, which is
today's behavior, accepted.

### 2. Notification matcher in `packages/plugins/claude-code/src/index.ts`

The `Notification` hook gains a matcher so only types where a human is
genuinely required ring the bell:

```
permission_prompt | agent_needs_input | elicitation_dialog | elicitation_url_dialog
```

Excluded, with the reason: `idle_prompt` (duplicates the turn-complete
signal), `auth_success`, `agent_completed` (a *background session* finished,
not this pane's turn — and "Needs your approval" would be the wrong copy),
`elicitation_complete` / `elicitation_response` (the human already acted),
`quota_auto_resume_*`.

### 3. The unseen gate in `notifySubshell` (server)

Once a push for a pane is delivered, follow-ups wait until the owner has
given that pane attention — one notification per unseen interval, broken
only by an escalation. The gate sits in `notifySubshell`, beside the bell
and the master switch, still the single policy point above both transports.

**State** is one nullable column on the subshell row, `last_push_urgency`
(the migration also registers in the `migrate.ts` provider map, per the
both-places rule). Unseen ⇔ non-null. Urgencies:

| kind | urgency |
|---|---|
| `turn_complete` | 1 |
| `needs_attention` | 2 |
| `exited`, `crashed`, `maintenance` | 3 |
| `crashed_final` (the restart loop gave up) | 4 |

**The rule**: a push fires only when the stored urgency is strictly below
the event's (null passes everything). On a delivered attempt the column
stores the max of itself and the event's urgency. Consequences: done-after-
done and approval-after-approval push nothing; approval after done pushes
once; a death always lands (waiting is moot when the pane is gone); a death
is a one-way transition so two urgency-3 events never contend on one pane,
and `crashed_final` sits above any unseen `crashed`. A push with no
subscribers and no enrolled devices sets nothing — an undelivered event must
not silence the pane forever.

**Clearing** happens when the subshell's **owner reads the pane as a human
session** — cookie principal, `userId` equal to the row's: the pane detail
GET, the pane log GET, or the live-terminal attach (any of the owner's
clients; a push tap that opens the pane clears it). It deliberately is NOT
cleared by:

- the pane-scoped list GET (the sidebar polls it constantly);
- shared viewers or admins — pushes are owner-targeted;
- **machine credentials**: a subshell token or system key resolves as the
  owner with the boost, so an agent polling `get_subshell` over MCP would
  clear the flag every call and a prompt-injected pane could re-arm
  notifications against its owner. Only cookie sessions clear.

`waitingSince` and the dashboard chip are untouched by this gate — the chip
still marks every waiting event; only the push waits.

**The rail says it too.** The unseen state becomes visible where the owner
already looks: the subshell view carries `unseenPush: boolean` (non-null
`last_push_urgency`), and `SubshellDot` swaps the dot for a bell glyph while
anything is unseen — colour still carries the indicator state, the glyph
carries "pushed and you have not looked". The raw `data-status`/`data-alive`
pair rides along, because the e2e liveness assertions read this element in
either shape. Every write to the column announces `subshell.changed`: the
rail is live-fed, not polled.

### 4. What does NOT change

The `attention` route and its self-scope, `recordAttention`, `NotifyKind`,
the bell and master switch, the Expo/web-push transports, the 20 s idle
watcher for hook-less harnesses (terminal / hermes / pi — they get no richer
signal, though the unseen gate rings their second turn_complete down too),
push copy, and the waiting-chip set/clear paths. Every one of these keeps
its mechanism; §1 decides whether a stopped turn *reports*, and §3 decides
whether a report *rings*.

## Failure modes

- **Never-waking background work.** An agent that leaves a `tail -f`-style
  forever shell or a recurring loop running suppresses that turn's push; the
  next Stop that finds the registry empty pushes. Chosen knowingly (the
  "any task or cron" option over the waking-types split).
- **Old Claude Code.** No `background_tasks` field → the gate never
  suppresses → exactly today's behavior. No version probe is attempted
  (a plugin parses nothing it cannot see; absent data means unknown, and
  unknown pushes).
- **The report stays fire-and-forget.** Every path still exits 0 and prints
  nothing; a gate misreading cannot break a turn.
- **Unseen is per pane, not per device.** A push the phone received silences
  the laptop's follow-ups too until any one owner session opens the pane.
  The pane has one owner and one unfinished visit; the state matches that.

## Tests

- `packages/mcp-core`: the table above, pinned with the existing injectable
  `readStdin`/`fetch` seams — suppression on each non-empty array, push on
  each unknown-shape row, and that `needs_attention` never touches stdin.
- `packages/plugins/claude-code`: the emitted `--settings` JSON pins the
  narrowed matcher string.
- Server notify tests: the urgency table end to end — done-after-done
  silent, approval-after-done fires, approval-after-approval silent, death
  fires over any unseen state, no-subscriber attempt sets nothing.
- Clear-path tests: owner cookie detail/log/attach clears; viewer, admin,
  subshell token, and system key do NOT; the list route never clears.
- Rail tests: `unseenPush` reaches the view; the dot becomes a bell while
  unseen (raw pair intact, tone by indicator); no bell when seen; the
  web-side `SubshellView` mirror carries the field.

## Surfaces this ships through

`@internal/server` (it bundles the reporter and seeds the plugin) and the
`@subshell-ai/plugin-claude-code` package; the node binary bundles the same
`report` verb. Changesets: patch/minor on `@internal/server` and the
claude-code plugin at implementation time.
