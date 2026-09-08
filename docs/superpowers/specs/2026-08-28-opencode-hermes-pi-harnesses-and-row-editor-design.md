# Harnesses for opencode / Hermes / pi, and a row-based env & flag editor

Date: 2026-08-28
Status: approved (user delegated implementation decisions)

## Goal

Teach mote to launch three more agent CLIs — **opencode**, **Hermes Agent** (Nous
Research), and **pi** — with the same profile machinery already used for Claude
Code, and rebuild the profile editor's env-var and flag inputs as autocomplete-
backed key/value rows with a bulk-paste affordance.

Depth of support is **full parity with Claude Code**: install detection, version,
interactive launch under tmux, profile env/flags applied, a small `settingsFields`
schema, and suggested env/flags — everything `HarnessPlugin` exposes.

## Non-goals

- **Session-resume wiring.** Restarting a mote session re-runs the launch command
  for every harness, including Claude Code today. Wiring `--continue`-style resume
  is a cross-cutting behavior change and stays out of scope.
- **Settings-editor UI.** `settingsFields` are defined and served by the new schema
  endpoint but have no editor yet — same as Claude Code today. Flags cover the same
  ground from the UI.
- **Config isolation.** No isolation switch is added. opencode and pi expose real
  isolation knobs (`OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`); they are surfaced
  as *suggested env rows* rather than new machinery.
- **Frontend changes beyond the profile editor.** The setup page, harness selector,
  and session views consume the registry dynamically and need no edits.

## Part 1 — Harness plugins

Three new files in `packages/harnesses/src/`: `opencode.ts`, `hermes.ts`, `pi.ts`.
Each is a class implementing `HarnessPlugin` in the image of `claude-code.ts`
(binary-override constructor for tests, `findBinary(name, envOverride, knownPaths)`
for lookup). Registered in `ALL_HARNESSES` in `index.ts` via static imports
(no dynamic imports, per repo convention).

Verified against the live binaries on this machine (2026-08-28):

| | opencode 1.18.18 | Hermes 0.16.0 | pi 0.79.6 |
|---|---|---|---|
| id / icon | `opencode` / ✳️ | `hermes` / 📮 | `pi` / π |
| binary lookup | `opencode`, env `OPENCODE_PATH`, known `~/.opencode/bin/opencode` | `hermes`, env `HERMES_PATH`, known `~/.local/bin/hermes` | `pi`, env `PI_PATH`, PATH-only (node global) |
| version probe | `--version` → `1.18.18` | `--version` → first non-empty line (`Hermes Agent v0.16.0 …`) | `--version` → `0.79.6` |
| launch | bare argv → TUI | bare argv → chat (respects the user's `display.interface`) | bare argv → TUI |
| settings → flags | `model`→`-m`, `agent`→`--agent`, `auto`(bool)→`--auto` | `model`→`-m`, `provider`→`--provider`, `toolsets`→`-t` | `model`→`--model`, `provider`→`--provider`, `thinking`→`--thinking` |
| session name at launch | not supported — ignored | not supported — ignored | `--name <n>` |
| suggested env | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_TUI_CONFIG`, `OPENCODE_API_KEY` | `HERMES_HOME`, `HERMES_INFERENCE_MODEL` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_TELEMETRY` |
| suggested flags | `-m provider/model`, `--agent <name>`, `--auto`, `--pure`, `--prompt <text>` | `--tui`, `--cli`, `-m <model>`, `--provider <p>`, `-t <toolsets>`, `--yolo`, `--worktree`, `--safe-mode` | `--model <pattern>`, `--provider <name>`, `--thinking <level>`, `--tools <list>`, `--append-system-prompt <text>`, `--offline` |
| `exitStatus` | omitted (no documented code contract) | omitted | omitted |

All three: `ttyRequired: true`, `enabledByDefault: true`. Suggested env lists also
implicitly cover the per-provider `*_API_KEY` variables (ANTHROPIC, OPENAI,
GEMINI, OPENROUTER, …) — those are *not* listed per harness; the profiles docs
already treat API keys as free-form env entries.

**Shared validation.** All four plugins need the same generic profile checks
(name required; env values are strings; flags start with `-`). Extract
`validateGenericProfile()` into `packages/harnesses/src/validate.ts`; every
plugin's `validateProfile` delegates to it. Behavior is unchanged for Claude
Code — the existing test guards the refactor.

**Launcher-script caveat (documented in code).** Hermes' `hermes` on PATH is a
bash launcher script. Mote's launch path (`buildHarnessCommand` → `env -i …`
under tmux) scrubs the inherited environment, so sessions are unaffected — but
a *backend server process* started from a shell exporting `SHELLOPTS` containing
`onecmd` would break every multi-line bash launcher it probes (`getVersion`).
A comment in `hermes.ts` records this; no code works around it.

## Part 1.5 — Claude Code suggestion refresh

`SUGGESTED_ENV` gains: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `BASH_DEFAULT_TIMEOUT_MS`,
`MAX_THINKING_TOKENS`.

`SUGGESTED_FLAGS` gains: `--continue`, `--resume`, `--effort <level>`,
`--fallback-model <alias>`, `--max-turns <n>`, `--worktree`, `--fork-session`,
`--session-id <uuid>`, `--allowedTools <list>`, `--disallowedTools <list>`,
`--mcp-config <path>`. Removed: `--no-session-persistence` (a print-mode-only
flag — wrong for interactive sessions). Each addition is verified against
`claude --help` output during implementation, not just the docs scrape.

## Part 2 — Schema endpoint

`GET /api/profiles/harnesses/:id/schema` on `profiles.route.ts` (next to the
existing `/harness-ids` reference endpoint; auth-guarded like the rest of the
route; `/schema` suffix so it can never be shadowed by a future `GET /:id`):

```
{ settingsFields: [{key,label,description?,type,choices?,default?}],
  suggestedEnv:    [{key,description}],
  suggestedFlags:  [{flag,description}] }
```

Unknown harness id → 404 via the existing `ProfileError("not_found", …)` pattern.
Full Elysia `t` schemas with `description` on every property, per repo rules.

## Part 3 — Profile row editor (frontend)

### Data model — `lib/profile-form.ts`

```ts
interface ProfileFormValue {
  harnessId: string;
  name: string;
  envRows: EnvRow[];    // { key: string; value: string }
  flagRows: FlagRow[];  // { flag: string; value: string } — "" = bare flag
  restartOnExit: boolean;
}
```

`envText`/`flagsText` are gone. Conversions (pure, all in this module, all tested):

- `emptyProfileForm()` → one empty row per section (so the first row is ready to type).
- `profileFormFromRow(row)` → env object entries → rows; flat flags tokens → rows
  by pairing each `-`-prefixed token with the tokens up to the next `-`-prefixed
  one (space-joined into the value).
- `formToEnv(rows)` / `formToFlagTokens(rows)` for submit: empty key/flag rows are
  skipped; a flag's value is emitted as **one argv token** (whitespace inside is
  preserved). This is a deliberate behavior change: `--append-system-prompt be nice`
  used to save as three tokens and break; it now saves as one correct argument.
  Round-tripping profiles that already exist is unaffected (their values are
  single tokens already, or joined then re-split identically).

### Bulk paste

Each section header gets a small "Paste many" toggle revealing a `Textarea` and an
"Add N rows" button. Parsing is append-only — existing rows never disappear, and a
parse failure shows an inline message without touching state.

- `parseEnvPaste(text)`: accepts a JSON object, `KEY=value` lines, `export
  KEY=value`, `#` comments and blank lines. Values may contain `=` (split on the
  first `=` only).
- `parseFlagsPaste(text)`: accepts one flag per line **or** a whole command line.
  Quote-aware tokenizer (single and double quotes, backslash escapes inside
  double quotes); tokens starting with `-` begin a new row, other tokens join the
  current row's value (space-joined); tokens appearing before the first flag
  (e.g. a pasted `opencode ` binary prefix) are dropped, as is a leading `--`
  separator.

### `AutocompleteInput` component

`components/autocomplete-input.tsx` — a controlled text input plus a filtered
dropdown:

- props: `value`, `onChange`, `suggestions: { value: string; detail?: string }[]`,
  `placeholder`, `aria-label`, and the standard input passthroughs.
- filter: case-insensitive substring; exact-prefix matches sort first; hidden when
  the input is unfocused, or when the filtered list is empty, or when the value
  exactly equals a suggestion.
- keyboard: `ArrowDown/Up` move selection (wrapping), `Enter` commits the selected
  suggestion, `Escape` closes, `Tab` closes without changing; blur closes.
- mouse: `mousedown` + `preventDefault` so selection wins over blur.
- unknown values are accepted freely — suggestions never restrict input.
- no new dependencies: plain absolute-positioned list (~100 lines). The `cmdk`
  package in `apps/frontend/package.json` is unused by anything; it is removed as
  part of this change (dead dependency, pinned-version rule aside it is just
  `bun remove cmdk` + lockfile).

### Rows UI in `ProfileFields`

- **Env vars:** grid of `[key | value | remove]` rows; the key field is an
  `AutocompleteInput` fed by the harness schema (`suggestedEnv`: key + description
  as detail); value is a plain `Input`; a ghost "+ Add row" button below.
- **Flags:** rows of `[flag | value | remove]`; the flag field autocompletes from
  `suggestedFlags` (flag + description). The value input's placeholder says
  "optional" — an empty value renders a bare flag.
- **Schema fetch:** `useHarnessSchema(harnessId)` React Query hook
  (`queryKey: ["harness-schema", harnessId]`) pointing at Part 2's endpoint;
  while loading or for a harness with no suggestions the fields render as plain
  inputs. Changing the harness Select naturally re-keys the fetch.

### Call sites

`profiles.tsx` (create) and `profiles_.$id.tsx` (edit) move from
`parseEnvJson/parseFlags` to the row converters; the create/edit validation
message for malformed env JSON becomes: bad JSON in paste mode is reported at
paste time, so submit-time errors shrink to "Choose a harness first" / empty
name handling as today. The profile cards' `env:`/`flags:` preview lines keep
reading the stored JSON blobs unchanged.

## Testing

- `packages/harnesses/src/__tests__/`: `opencode.test.ts`, `hermes.test.ts`,
  `pi.test.ts` (metadata, buildCommand mapping incl. settings/flags/name and
  ordering, validateProfile delegation, binary-override installed/missing,
  version parsing for hermes multi-line) and `validate.test.ts` for the shared
  helper; `claude-code.test.ts` keeps passing unchanged except any new list edits.
- `apps/backend`: route test for `GET /api/profiles/harnesses/:id` (known id →
  payload shape; unknown id → 404).
- `apps/frontend`: `profile-form.test.ts` rewritten for rows + both paste parsers
  (JSON env, KEY=value, export lines, comments, `=` in values; multi-line flags,
  single command line with quoted values, junk-before-flag, `--` separator) and a
  pure `filterSuggestions()` helper test for the autocomplete ranking.
- Full verification trio (`bun run verify-types`, `bun run lint:check`,
  `bun run test`) plus `turbo build` (new route → Eden client types).
- Live check: restart backend, confirm `/api/setup/harnesses` lists all four with
  installed + version, create one profile per new harness through the UI or API,
  and launch a quick `pi` session in tmux to confirm the argv shape end-to-end
  (kill it afterwards).

## Rollout

Single feature branch off `main`, small logical commits
(plugins → shared validation + claude refresh → endpoint → editor → cleanup),
pushed at the end with a normal PR flow if desired. Unpushed commits already on
`main` from earlier sessions are unrelated and stay untouched unless the user
asks.
