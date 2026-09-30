# Presets carry the launch; the copy picker is removed

Date: 2026-09-29. Status: approved by the operator in dialogue (the three
rulings below are quoted at their decision points).

## Summary

The launch form's "Copy settings from a subshell" picker is removed entirely.
Its job - reusing a prior launch's node, directory, and prompt - moves to
**presets**, which gain three optional fields: `nodeId`, `workingDir`, and a
prompt stored as the same block stack the new-subshell form composes. An MCP
agent can then launch from a preset alone: `create_subshell` REQUIRES a preset
and takes the preset's values as the launch, with the agent's own `node`,
`working_dir`, and prompt as explicit overrides. A preset with a machine and a
directory filled can be switched cross-comm ready: any agent can then start
from its id alone and know exactly where it will run.

Close/Terminate/Delete behavior stays exactly as on `main`. The
`feat/close-keeps-the-row` branch is deleted after its one unrelated commit (the
prompts page's single "New" button) is cherry-picked onto this work.

## Operator rulings (2026-09-29)

1. "I want to remove that picker entirely." - the copy picker and everything
   existing only for it are deleted; the last-launch auto-default tier STAYS
   (kept by explicit choice when asked).
2. "We add the node and path and prompts to use as optional in the preset...
   for a preset to be cross comm available they need to have all optional
   values filled." - the three optional columns plus the derived readiness
   flag.
3. "Preset prompt area should work like the new subshell one." - the preset
   editor reuses the launch form's block picker (`prompt-picker-body.tsx`,
   `prompt-stack.ts` transforms) and its snapshot semantics: picking a saved
   prompt or stack stores its text AT PICK time, so later library edits never
   change what a preset launches.
4. "MCP create subshell can specify a dir to override if it wants to. It can
   determine if to use the prompt, add on top of it, or use its own entirely.
   Make create_subshell require a preset to use." - preset mandatory; `node`
   and `working_dir` become overrides; prompt is composed by mode
   (`append` default, `replace`).
5. "Just have the verb behavior like it is from main" + "remove the branch" -
   `feat/close-keeps-the-row` is never merged; only its prompts-New-button
   commit is preserved.

## 1. Preset model

Migration `0042-preset-launch-fields.ts` adds three NULL-able columns to
`presets`:

- `node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL` - a deleted node
  unsets it; the preset drops out of cross-comm readiness visibly (badge
  recomputes from the row), rather than keeping a launch that must fail.
- `working_dir TEXT` - absolute path, same validator as the create body
  (`minLength 1`, ≤4096). Validated on preset write, enforced against the
  node's directory allowlist at every launch as any hand-typed dir is.
- `prompt_blocks TEXT` - JSON array of preset prompt blocks, the wire shape of
  the launch form's stack WITHOUT `localId` (form-local by contract):
  `{ kind: "saved" | "custom" | "stack", promptId?, stackId?, stackCount?,
  description, body }`. `body` is the snapshot text; the server joins bodies
  with ONE blank line (the same rule as `joinPromptBlocks`). The shape and the
  join live in `@internal/subshell-protocol` (new module `preset-prompt.ts`)
  so web, server, and MCP share one definition - web adds `localId`s back on
  load, exactly as a stack pick does.

Presets stay per-harness; nothing else in the row changes.

## 2. Launch resolution (server)

`subshells.service.createSubshell` resolves the launch facts from the chosen
preset BEFORE validating, request wins, preset fills gaps:

- `nodeId = body.nodeId ?? preset.nodeId` - a preset's node behaves exactly
  like an explicit one: unknown 400, offline existing error, harness-usable
  gate unchanged. No silent fallback to the resolve ladder when a preset named
  a node; cross-comm launches must be deterministic. With neither, the
  existing ladder (`local` → lone online agent) runs as today.
- `workingDir = body.workingDir ?? preset.workingDir` - `workingDir` moves to
  optional on the create body; when neither supplies one the route answers the
  existing 400, its message updated to name the preset option ("provide
  workingDir or a preset that carries one").
- `prompt = body.prompt ?? joinBodies(preset.promptBlocks)` - `promptDelivered`
  honesty unchanged.

Restart does not re-read the preset's launch fields (the row already holds the
dir and the prompt was a creation-time act); `restart-preset-swap` keeps its
current meaning.

## 3. MCP `create_subshell`

`packages/mcp-core`: `preset` becomes a REQUIRED string (addressed by id since the 2026-09-30
re-ruling below; it was first resolved by name
against `GET /api/presets` as today; unknown name refuses with the remedy).
Consequences:

- `harness` drops to optional assert: when given it must equal the preset's
  harness (mismatch 400 naming both), since the preset already names one.
- `working_dir` drops to optional: an override that wins over the preset's, as
  the ruling says. When neither the call nor the preset supplies one, the tool
  returns the server's 400.
- `node` stays an optional override.
- `prompt` optional; `prompt_mode: "append" | "replace"` (default `append`)
  only matters when both the call's `prompt` and the preset's blocks are
  present: `append` joins the agent's text AFTER the preset's with the one
  blank line, `replace` sends only the agent's. A call with no `prompt` uses
  the preset's.
- Tool description states the model: presets are how agents launch; a
  cross-comm-ready preset needs only its name.

`list_presets` gains `crossCommReady: boolean` per row so an agent can pick a
preset that launches from its id alone.

## 4. Cross-comm ready (amended same day, at the operator's test drive)

An OPT-IN, stored since migration 0043, AND a requirement: the row's
`cross_comm_enabled` switch AND `nodeId`/`workingDir` set. The prompt is
OPTIONAL launch data (operator re-ruling 2026-09-30, same day): a preset that
names where to run can be launched by an agent even when it says nothing to type;
the stack rides along as launch data when present. An unreadable
`prompt_blocks` column no longer bears on readiness - it surfaces only at
launch, where the MCP append path refuses it by name. The protocol package
holds the one rule: `presetLaunchRequirementsMet` (machine + directory) and
`isPresetCrossCommReady` (switch AND machine + directory).

- Editor: a Switch labeled "Enable agents to create subshells with this preset"
  (copy restated at the 2026-09-30 test drive; help text "Enables agents to
  create subshells with this preset using MCP."). The switch is DISABLED while
  a requirement is missing, and the section lists ONLY the missing items, in
  the warning amber. When the
  switch is ON and a later edit breaks a requirement, SAVE is disabled and the
  missing items highlight - the operator fixes the fields or turns the switch
  off; the server enforces the same rule on create and update (400).
- `list_presets` flag (§3): `crossCommReady` means the whole rule, so a
  filled-but-unswitched preset makes no agent-facing promise.
- Presets list page: the "cross-comm ready" badge shows on ready rows only.

## 5. Copy picker removal

Delete: the picker checkbox+combobox block in `new-subshell-form.tsx`
(correction at implementation: there was no separate `subshell-copy-picker.tsx`
- the picker lived inline in the form), `applyCopy` from
`use-launch-form-defaults.ts` (the hook keeps the auto-tier effect),
`copySettingsOptions`/`copyOption`/`byEndedRecent`/`ACTIVE_GROUP`/
`RECENTLY_TERMINATED_GROUP`/`COPY_CATEGORY_PREVIEW` from `lib/launch-defaults.ts`
(the file keeps `LaunchTemplate`, `launchTemplateFromRow/List`,
`isUntouchedForm`), `groupPreviewLimit` from `combobox.tsx` (groups, divider,
and `consumed` stay - the prompt picker uses them), the `copy` id in
`launch-form-rules.ts` + `setup.tsx`'s override, `launchTemplateFromList`'s
terminated-feeding (correction: the `terminated=1` query param never existed
on main; the list was already all-status), and the unreferenced `status`
filter param on `listVisibleTo` (verified dead), plus the picker-only describes in
`launch-defaults.test.ts`, `new-subshell-form.test.tsx`, `combobox.test.tsx`.
No e2e or mobile coverage exists for the picker.

## 6. Launch-form prefill from a preset

Picking a preset in the launch form prefills node, working dir, and the prompt
blocks (fresh `localId`s), each still editable - prefill, not lock; the auto
tier yields to it. A preset without one of the fields leaves that control
untouched. Switching presets re-applies: fields the new preset names are
overwritten, fields it lacks KEEP their current value (implementation ruling;
the plan's tests pin it): silently re-writing a control behind the person
reads worse than a stale value they can still edit or clear by hand. The
explicit-none leak this used to risk is closed at the wire: a launch from a
preset with an empty stack sends `prompt: ""`, which the server reads as
"none" instead of falling back to the preset's blocks.

## 7. Not doing

- No mobile preset UI (mobile never had one).
- No live prompt references (snapshot semantics, ruling 3; deleting a library
  prompt never changes what a preset launches).
- No field-level "locked vs suggested" semantics on presets.
- No server change to Close/Terminate/Delete (ruling 5: verbs are main's).

## 8. Testing

- Migration + presets route: create/update carry the three fields; validation
  rejections (bad node id, relative dir, malformed blocks JSON); PUT clear-set.
- `subshells.service` resolution matrix: explicit-over-preset for all three;
  preset-only dir; missing both → 400 wording; preset node unknown/offline.
- Protocol: `joinPresetPrompt` matches `joinPromptBlocks` byte-for-byte on the
  same bodies.
- MCP: preset required (schema); harness assert; working_dir override;
  prompt_mode append/replace; crossCommReady in list output.
- Web: preset editor round-trips blocks and shows the completeness line;
  launch form prefills from preset and the picker is gone (trimmed tests);
  combobox keeps prompt-picker behavior with `groupPreviewLimit` deleted.
- Prompts page: one "New" button opens the kind menu (re-applied commit, its
  tests ride).

## 9. Docs

`docs/launch-form-picker.md` and `apps/server/web/AGENTS.md` lose the picker
sentences; `apps/server/web/docs/presets-system.md` (and the preset editor's
help text) gain the three fields + cross-comm rule; `packages/mcp-core` tool
descriptions rewrite; CHANGELOG via changeset. The security posture is
unchanged: preset dirs face the same allowlist, preset nodes the same
harness/usability gates, and a preset prompt rides the same typed-input path as
the form's (`.claude/rules/security-context.md` needs no edit).
