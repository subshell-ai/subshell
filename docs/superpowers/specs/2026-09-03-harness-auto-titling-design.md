# Let the harness title the pane: stop baking the generated default into `--name`

**Date:** 2026-09-03
**Status:** Approved design, pre-implementation

## Summary

When a subshell is created without a user-chosen title, the manager generates a
date/time placeholder (`defaultSubshellName()`, e.g. `2026-09-03 14:30`) and today
that placeholder rides all the way into the pane command: the Claude Code and pi
plugins pass any non-empty `subshellName` as `--name`, and Claude's `--name` pins
the display name "shown in the prompt box, /resume picker, and terminal title".
A pane named by us is a pane the harness never names — and the reconcile sweep's
auto-adoption (which mirrors `#{pane_title}` into `row.name` for every unlocked
row) can never fire, because its "title equals current name" rejection makes
placeholder-equals-title a permanent no-op.

The fix mirrors how a normal terminal works: nobody assigns a title, and the
program running inside fills it in. **Pass only user-chosen names to the launch
command.** When the user did not name the subshell, the pane command carries no
`--name`, the harness titles the pane itself (now and on every later context
change), and the existing sweep adopts each new title into `row.name` until a
human renames or pins the subshell.

## Non-goals

- No "untitled" row state (`row.name` stays NOT NULL; the placeholder remains
  the display name until the harness's first real title lands — approach B,
  rejected: it churns a column, route validation, and every UI/notification/
  audit surface to fix what the sweep already smooths over).
- No filter for generic product titles (e.g. "Claude Code" as the very first
  OSC title): the adopted name follows whatever the unlocked harness says,
  including brief generic titles and every later update. The sweep's existing
  rejection list (running command, host name, same-as-current) is unchanged.
- No change to the `SUBSHELL_NAME` env var — it keeps baking the row's display
  name (placeholder included). It is a once-at-launch roster label for the MCP
  identity and cannot track later adoptions anyway.
- No changes to harness plugins, `TmuxRunner`, the node launch RPC (it forwards
  whatever the plan carries), the sweep, or the frontend.

## 1. The one signal that matters: who named this row?

Two producer paths exist, and each already holds the distinction:

- **Create** (`subshell-manager.service.ts`, `createSubshell`): the request's
  `name?.trim()` is exactly "the user chose a title"; empty means nobody did.
- **Restart** (`#reviveRow`): `nameLocked` is exactly "a human owns this name"
  — `updateName` sets it on every manual rename and the pin toggle sets it
  directly (migration 0011 semantics). The sweep only ever writes names
  into `nameLocked = 0` rows, so an unlocked name is by construction
  placeholder-or-adopted, never human.

`BuildCommandInput.subshellName` already documents `"" = let the harness pick a
default`, and both consuming plugins (`claude-code.ts`, `pi.ts`) already guard
with `if (subshellName)`. No new contract is needed — only the manager stops
feeding it a placeholder.

## 2. Changes (single file: `apps/server/src/services/subshell-manager.service.ts`)

**`createSubshell`** — separate display name from launch name:

```ts
const userNamed = name?.trim() ?? "";
const subshellName = userNamed || defaultSubshellName(); // DB row + SUBSHELL_NAME env: unchanged
```

`launcher.launch({ ..., subshellName: userNamed })`. A user-typed name behaves
exactly as today (`--name` sent); an unnamed create sends none.

**`#reviveRow`** — restart keeps only human names:

```ts
subshellName: row.nameLocked === 1 ? row.name : "",
```

`subshellMcpEnv(apiKey, row.id, row.name)` stays as-is. The lock check lives at
this call site (the row is freshly read there); no launcher/plugin signature
changes.

## 3. Resulting lifecycle (name never touched by a human)

1. Create: DB shows the date/time placeholder; pane command has no `--name`.
2. Harness titles the pane (its product title, then per-task titles); each
   reconcile sweep adopts the current title into `row.name` — repeatedly, not
   one-shot, because adoption fires whenever title ≠ current name.
3. Restart: sends `""` again; the fresh pane's titles keep flowing in.
4. A rename or pin flips `nameLocked = 1`: the sweep stops reading the title,
   and restarts send the locked name back as `--name`. This is the pre-existing
   behavior and stays correct.

Remote-node rows follow the same path for free: the node probe's
`entry.title`/`entry.command` feed the identical adoption branch, and the launch
plan forwards the (now empty) `subshellName` verbatim.

## 4. Error handling & edge cases

- **Rollback paths**: unchanged — an unnamed launch failing still marks the row
  terminated and revokes the token; the row keeps its placeholder name either
  way.
- **Adoption between create and restart**: `#reviveRow` reads the row fresh, so
  a placeholder or an adopted title are both seen as unlocked → `""`. A
  mid-flight rename is honored by the same fresh read.
- **Empty-but-padded names** (`"   "`): `userNamed` trims to `""` — treated as
  unnamed (matches today's `|| defaultSubshellName()` treatment of whitespace).
- **Harnesses without `--name`** (codex, opencode, hermes): unaffected — they
  never consumed the name, and pane-title adoption was already their only
  naming path.

## 5. Testing

Manager-level tests (existing suite, `__tests__/`):

- create without a name → `launch` receives `subshellName: ""`, while the row
  and the baked `SUBSHELL_NAME` env carry the date/time placeholder;
- create with a name → `launch` receives it verbatim (regression guard for the
  human path);
- revive with `nameLocked = 1` → launch receives the row name; revive with
  `nameLocked = 0` → launch receives `""` while the env still carries
  `row.name`.

Sweep adoption is existing covered behavior and is asserted unchanged (title
adoption still ignores locked rows). Full verification afterwards:
`bun run verify-types && bun run lint:check && bun run test`.
