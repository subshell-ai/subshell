# Hook-gated notifications (2026-09-23)

## The problem

The bell rings "Done, waiting for you" every time the harness stops producing
output. For a Claude Code pane that is wrong in two ways:

1. The injected `Stop` hook fires whenever the main loop ends its turn —
   **including when the session is merely parked waiting on a spawned
   subagent or a background task it will be woken by.** The push says "come
   back", and there is nothing to come back to.
2. The injected `Notification` hook carries **no matcher**, so every
   notification type — `idle_prompt`, `auth_success`, the
   `quota_auto_resume_*` family, `elicitation_complete` after the human has
   already answered — pushes "Needs your approval".

Both hooks are self-report surfaces that already exist
(`POST /api/subshells/:id/attention`); no server route, wire shape, DB or
transport change is needed.

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

### 3. What does NOT change

The `attention` route, `recordAttention`, `NotifyKind`, the bell and master
switch, Expo/web-push transports, the exited/crashed/maintenance paths, the
20 s idle watcher for hook-less harnesses (terminal / hermes / pi — they have
no richer signal and are not this complaint), push copy, and the waiting-chip
clear path in the idle watcher.

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

## Tests

- `packages/mcp-core`: the table above, pinned with the existing injectable
  `readStdin`/`fetch` seams — suppression on each non-empty array, push on
  each unknown-shape row, and that `needs_attention` never touches stdin.
- `packages/plugins/claude-code`: the emitted `--settings` JSON pins the
  narrowed matcher string.
- No server-side tests change; the route's contract is untouched.

## Surfaces this ships through

`@internal/server` (it bundles the reporter and seeds the plugin) and the
`@subshell-ai/plugin-claude-code` package; the node binary bundles the same
`report` verb. Changesets: patch/minor on `@internal/server` and the
claude-code plugin at implementation time.
