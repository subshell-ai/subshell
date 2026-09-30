# Presets carry the launch; copy picker removed - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Presets gain optional `nodeId`, `workingDir`, and a prompt block stack; the launch form prefills from the chosen preset; MCP `create_subshell` requires a preset and treats node/dir/prompt as overrides; the "Copy settings from a subshell" picker is deleted.

**Architecture:** Server-side resolution at `subshells.service.createSubshell` (request wins, preset fills gaps) so web, mobile, and MCP share one rule. Prompt blocks are a shared wire shape in `@internal/subshell-protocol` (snapshot bodies, joined by one blank line). Cross-comm readiness is derived from row values, never stored.

**Tech Stack:** Bun, Elysia, Kysely (SQLite migrations), React SPA (`@internal/server-web`), Zod MCP tools (`@internal/mcp-core`), happy-dom tests, Playwright e2e.

Spec: `docs/superpowers/specs/2026-09-29-preset-launch-fields-design.md`

## Global Constraints

- Verb behavior (Close/Terminate/Delete) is main's - this plan touches none of it.
- No em dashes in prose or shipped strings (`bun run lint:prose`); UI explanations ≤2 sentences; design roles (`text-detail` etc.).
- Pinned dependency versions; after `bun add` run `syncpack fix && bun install`.
- No dynamic imports; Elysia `t` schemas every property `description`; interface properties JSDoc'd.
- Focused verification while iterating; `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test` at every task boundary. Changes under `packages/` also need `bunx turbo build`.
- Preset WRITES stay cookie-only; reads stay open (list_presets depends on it).
- Commit author theo@suteki.nu.

---

### Task 1: Shared prompt-block shape in subshell-protocol

**Files:**
- Create: `packages/subshell-protocol/src/preset-prompt.ts`
- Modify: `packages/subshell-protocol/src/index.ts` (export)
- Test: `packages/subshell-protocol/src/__tests__/preset-prompt.test.ts`

**Interfaces:**
- Produces: `PresetPromptBlock` (wire type: `{ kind: "saved" | "custom" | "stack"; promptId?: string; stackId?: string; stackCount?: number; description: string; body: string }`), `parsePresetPromptBlocks(json: string | null): PresetPromptBlock[] | null` (throws `Error("bad_preset_prompt")` on malformed), `joinPresetPrompt(blocks: PresetPromptBlock[]): string`, `isPresetCrossCommReady(row: { nodeId: string | null; workingDir: string | null; promptBlocks: string | null }): boolean`.

- [x] **Step 1:** failing tests: join equals the web `joinPromptBlocks` rule (`bodies.join("\n\n")`), empty array joins `""`, parse round-trips a valid array, parse throws on non-array / non-object member / missing `body` / unknown `kind`, `isPresetCrossCommReady` true only when all three present and blocks non-empty.
- [x] **Step 2:** implement; export from `index.ts` (NOTE: barrel must stay Metro-safe - pure TS, no `node:` imports).
- [x] **Step 3:** `cd packages/subshell-protocol && bun test src/__tests__/preset-prompt.test.ts`, then `bunx turbo build` (other tasks consume from dist).
- [x] **Step 4:** commit `protocol: preset prompt blocks (shape, join, cross-comm readiness)`.

### Task 2: Migration + preset API carry node/dir/prompt-blocks

**Files:**
- Create: `apps/server/api/src/db/migrations/0042-preset-launch-fields.ts`
- Modify: `apps/server/api/src/db/types/presets.db-types.ts`, `apps/server/api/src/api/models.ts` (`PresetSchema`), `apps/server/api/src/api/presets.route.ts` (create/update schemas, `UPDATE_PRESET_KEYS`, validation), repository if it lists columns explicitly
- Test: `apps/server/api/src/api/__tests__/presets-route.test.ts` (+ `db/migrations/__tests__` if a column-assertion suite exists - check `0027-presets` test)

**Interfaces:**
- Consumes: Task 1's `parsePresetPromptBlocks`, `joinPresetPrompt`, `isPresetCrossCommReady`-relevant fields.
- Produces: `PresetTable.nodeId: string | null`, `.workingDir: string | null`, `.promptBlocks: string | null`; create body optional `nodeId`/`workingDir`/`promptBlocks: t.Array(PresetPromptBlockSchema)`; `GET /api/presets` rows carry all three (bearer reads already allowed - they gain disclosure of preset node/dir/prompt text; that's the same disclosure `list_presets` is designed to give); derived `crossCommReady: boolean` ADDED to the response projection (compute with `isPresetCrossCommReady`, keep `PresetSchema` fields + `crossCommReady`).

- [x] **Step 1:** migration: three nullable columns (`node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL`, `working_dir TEXT`, `prompt_blocks TEXT`). Run `bun test src/__tests__ -f preset` green (migrations run in test boot).
- [x] **Step 2:** route validation on create AND update: `workingDir` must start with `/` (same shape rule as the launch form's `isAbsolutePath` - mirror the server's existing check if one exists in `create-subshell.route.ts`; else `minLength 1` + `/^[\/]/` handler check); `promptBlocks`: each `body` non-blank after trim is NOT required (a blank body joins fine) but total `joinPresetPrompt` ≤ 20000 (same cap as the create body's prompt) else 400; `nodeId`: must resolve to a node the caller could launch on - reuse the same visibility/`canLaunch` answer `resolveLaunchNode`'s gate gives (extract or call `loadNodeAccess`; a foreign node id is a 404-style refusal naming nothing; unknown id 400).
- [x] **Step 3:** `PUT /:id` accepts the three keys (clear-settable: explicit `null` clears), `UPDATE_PRESET_KEYS` gains them, transform unchanged. `harnessId` stays fixed.
- [x] **Step 4:** tests: create/update round-trip; bad node 400; foreign node 404/403; relative dir 400; blocks over cap 400; `crossCommReady` true only when all filled; FK test: deleting the node nulls `node_id` (insert + `DELETE FROM nodes` + re-read).
- [x] **Step 5:** boundary verify + commit `server: presets carry node, working dir, and prompt blocks`.

### Task 3: Launch resolution (request wins, preset fills gaps)

**Files:**
- Modify: `apps/server/api/src/services/subshells.service.ts` (`createSubshell` ~line 337-483: after the preset lookup at ~389, before `resolveLaunchNode` at ~432, resolve `nodeId`/`workingDir`/`prompt` from `presetRow`; update the "a preset never names a node" comment at ~161 to say it MAY name one since spec 2026-09-29-preset-launch-fields), `apps/server/api/src/api/subshells/create-subshell.route.ts` (`workingDir` becomes `t.Optional`, 400 wording names the preset option, `prompt` cap check moves to the merged value)
- Test: `apps/server/api/src/api/subshells/__tests__/` (create route) + service-level resolution matrix test (find the existing create-subshell service test file; extend)

**Interfaces:**
- Consumes: Task 2 columns.
- Produces: resolution order `nodeId = body.nodeId ?? preset.nodeId ?? undefined` (undefined feeds the existing ladder; a preset-set unknown/deleted-then-nulled value cannot occur after FK, but a node that exists yet is offline/off-allowlist still errors exactly like an explicit one); `workingDir = body.workingDir ?? preset.workingDir` else existing 400; `prompt = body.prompt ?? joinPresetPrompt(parsePresetPromptBlocks(preset.promptBlocks) ?? [])`; `promptDelivered` semantics unchanged.

- [x] **Step 1:** matrix tests FIRST (red): explicit-over-preset for all three; preset-only dir launches; neither dir → 400 naming both spellings; preset node honored (its row's `nodeId` = preset's); preset prompt typed (assert `promptDelivered` + the deliver call); preset with FK-nulled node behaves like an unnamed node.
- [x] **Step 2:** implement; run the focused files.
- [x] **Step 3:** boundary verify + commit `server: launch resolves node/dir/prompt from the preset`.

### Task 4: MCP create_subshell requires a preset

**Files:**
- Modify: `packages/mcp-core/src/server.ts` (tool schema + descriptions; `list_presets` projection; the MCP instructions string ~line 342), `packages/mcp-core/src/subshell-tools.ts` (`createSubshell`: preset REQUIRED by name across ALL presets when `harness` omitted (fetch `/api/presets` unfiltered, match name case-exact then case-insensitive, cross-harness tie → refuse naming both harnesses), derive `harnessId` from the row; `workingDir` optional passthrough; prompt composition: no `prompt` → omit (server uses preset); `prompt_mode: "append" | "replace"` default `append` → append joins preset-joined text + "\n\n" + own (or own alone when preset has none); `replace` sends own; `crossCommReady` flows from the server list row)
- Test: `packages/mcp-core/src/__tests__/` (extend the create_subshell tool tests; mock `deps.api`)

- [ ] **Step 1:** failing tests: `preset` required (schema parse); harness omitted resolves via preset, mismatched explicit harness → error naming both; cross-harness name tie refused; working_dir override beats preset; append vs replace strings exact (fixture preset row with blocks).
- [ ] **Step 2:** implement; `list_presets` rows gain `crossCommReady`; catalogOnly description rewrite (those rows are NOT launchable via create_subshell anymore - create a preset first; keep the rows, they name harnesses for `create_preset`... CHECK: does an MCP create_preset tool exist? grep `create_preset` in mcp-core; if absent, say so in the description and drop the catalogOnly rows or reword them as informational; do NOT add a new tool in this plan).
- [ ] **Step 3:** boundary verify + `bunx turbo build` + commit `mcp: create_subshell launches from a preset; dir/prompt override it`.

### Task 5: Web preset editor - node, dir, prompt blocks, readiness badge

**Files:**
- Modify: `apps/server/web/src/types/preset.ts` (view fields + `isPresetCrossCommReady(preset)` helper derived from server flag), `apps/server/web/src/lib/preset-form.ts` (form value gains `nodeId`, `workingDir`, `promptBlocks` (form-local, `localId`s added on load per Task 1 rule)), `apps/server/web/src/components/presets/preset-fields.tsx` (+`create-preset-dialog.tsx`, edit route `routes/presets_.$id.tsx`): a Node select (harness-usable nodes, same source the launch form uses - check `launch-form-rules.ts` node rules + `use-nodes`), a working-dir field with the same folder-explore control the launch form uses, and the prompt block stack reused from the launch form (import `prompt-stack.ts` transforms + the picker `components/prompts/prompt-picker-body.tsx`; snapshot semantics identical), plus the completeness line (`detail` role: "Agents can launch this from its name alone" when ready, else "Missing: <list>"); `preset-list-row.tsx` badge "cross-comm ready" + tooltip.
- Test: `components/presets/__tests__/`, `lib/__tests__/preset-form.test.ts`

- [ ] **Step 1:** failing tests: form→payload carry the three (empty fields omitted/null); block load reassigns fresh `localId`s; completeness line strings both states; badge renders only when ready.
- [ ] **Step 2:** implement; wire both create + edit paths.
- [ ] **Step 3:** boundary verify + commit `web: preset editor sets node, dir, and prompt blocks; readiness badge`.

### Task 6: Launch form prefills from the chosen preset

**Files:**
- Modify: `apps/server/web/src/components/subshell-picker/use-launch-form-defaults.ts` (+ new: when the chosen preset changes, apply its node/dir/prompt blocks; fields the preset lacks revert to the auto-tier value; explicit user edits after apply are KEPT - track a per-field "dirty since apply" the same way the auto-tier's untouched-form check works, or simply apply on presetId change only, never on field edit), and the preset `Select` onChange in `new-subshell-form.tsx`
- Test: extend `subshell-picker/__tests__/use-launch-form-defaults.test.tsx` + `new-subshell-form.test.tsx`

- [ ] **Step 1:** failing tests: pick preset-with-all-three → node select shows it, dir filled, prompt stack shows its blocks (labels render); preset missing a field → that control untouched; switching presets replaces (old blocks gone); auto-tier (last launch) yields to preset when both.
- [ ] **Step 2:** implement + focused green.
- [ ] **Step 3:** boundary verify + commit `web: launch form prefills node, dir, and prompt from the preset`.

### Task 7: Remove the copy picker

**Files (per spec §5; verified against the footprint map):**
- Delete: `apps/server/web/src/components/subshell-picker/subshell-copy-picker.tsx`
- Modify: `new-subshell-form.tsx` (import line 28, `copyOptions` 139-146, `copyOpen` 155-159, checkbox+combobox JSX 196-240, header-comment picker sentences), `use-launch-form-defaults.ts` (drop `applyCopy` return + its now-unused imports; auto-tier effect stays), `lib/launch-defaults.ts` (drop `ACTIVE_GROUP`, `RECENTLY_TERMINATED_GROUP`, `COPY_CATEGORY_PREVIEW`, `copyOption`, `byEndedRecent`, `copySettingsOptions`, the `ComboboxOption` import; keep `LaunchTemplate`/`launchTemplateFromRow`/`launchTemplateFromList`/`isUntouchedForm`), `ui/combobox.tsx` (drop `groupPreviewLimit` + its doc + the `previewing`/visibleOptions memo and the `groupPreviewLimit != null ||` clauses - keep the `consumed` half; groups/divider stay), `subshell-picker/launch-form-rules.ts` (drop `copy` id from `DialogIdParts` + `DIALOG_IDS`), `routes/setup.tsx` (drop `copy: "setup-copy"`), `components/prompts/prompt-picker-body.tsx` ~line 390 comment naming "Copy settings from" (reword), `apps/server/web/docs/launch-form-picker.md` (lines 74-75 + 94-125 picker/auto sentences rewritten: auto tier survives alone), `apps/server/web/AGENTS.md` ~148-156.
- Server: `api/subshells/list-subshells.route.ts` + service `listSubshells` (`includeTerminated`/`terminated=1` param dies - verify zero remaining callers first: `grep -rn 'terminated=' apps/server/web/src apps/client/mobile/src packages/mcp-core/src`), `subshells.repository.ts` `listVisibleTo` `status` param (verify dead).
- Tests: DELETE `launch-defaults.test.ts` copySettingsOptions describe + related imports; DELETE `combobox.test.tsx` "group preview cap" describe (keep divider test; neutralize the "Recently terminated" fixture labels); TRIM `new-subshell-form.test.tsx` picker its-cases (~885, 918, 1006, 1050, 1073, 1105); mobile `new.test.tsx` 304-326 case (picker-mirror wording) reworded not deleted; server list tests covering `terminated=1` (find via grep) removed.
- e2e: none cover the picker (`grep -rn "Copy settings" e2e/tests` = empty; re-verify).

- [ ] **Step 1:** grep-verify every claimed caller/dead param before deleting (bun silently skips missing test paths - count files run).
- [ ] **Step 2:** remove + trim; run touched web + server test files; type-check.
- [ ] **Step 3:** boundary verify + commit `remove the copy-settings picker; presets carry launch reuse now`.

### Task 8: Docs, changeset, final review loop

**Files:** `apps/server/web/docs/presets-system.md` (three fields + cross-comm rule + badge), `apps/server/web/AGENTS.md` (preset paragraph), `packages/mcp-core` README/description already task-4'd, `.changeset/*.md` (minor bump for `@internal/subshell-protocol`, `@internal/mcp-core`, server/web per repo convention - check recent changesets), this plan checked off.

- [ ] **Step 1:** write docs + changeset; full `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test`; `bunx turbo build`.
- [ ] **Step 2:** code-reviewer agent on the saved diff (read-only, from a /tmp diff file); fix findings; repeat rounds until a clean pass (memory: review until clean).
- [ ] **Step 3:** commit; then finishing-a-development-branch skill (normal repo: 4 options).
