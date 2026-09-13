# Presets replace profiles: agent-first launch, optional preset

Date: 2026-09-13
Status: approved (owner decisions inline below)
Supersedes: 2026-08-31-default-profiles-design.md (whole), 2026-09-02-node-profile-pairing-design.md (pin half), and the profile half of 2026-09-10-plugins-phase5-settings-design.md's naming.

## 1. The problem, stated exactly

A profile was doing two jobs at once, and the second job's name was attached to the first job's act:

- **Choosing the harness was smuggled through the profile.** `profileId` was required to create a subshell, so the launch dialog never asked "which agent" — it asked for a profile, and its options read `Default (pi)`: a harness picker wearing a costume, with the meaningful word in parentheses. The first-run wizard relabels this field "Agent" (2026-09-11 pass), which is the tell.
- **Customising meant leaving.** Adding one flag to a launch meant going to `/profiles`, re-picking the harness, filling a form, coming back, and finding the row.
- **The consequence of requirement was the Default.** Because every launch needed a row, the server seeded a blank "Default" profile per (user × plugin) at four seams — registration, admin user create, plugin install, boot backfill — with an `is_default` flag, a DELETE 409, an impact-report `defaults` count, and a sanctioned repository bypass. All of that machinery exists for one reason: `profileId` was NOT NULL. The seeded row is an empty name that only exists so the picker has something to show.
- **Two words, one screen.** "Profile" also names the account page (and the two forms shared the element id `profile-name`). "Harness" is jargon.

## 2. The model

A **preset** is an optional saved customisation for one harness: env, flags, settings, auto-restart. That is its whole job. Launching needs only an **agent** (the UI label for a plugin/harness; `harnessId` stays the field name in code — "agent" the word is reserved for the node daemon by the vocabulary rule) and a folder.

The decisions, each made by the owner on 2026-09-13:

1. **Rename profile → preset everywhere**, internally and externally — table, routes, hooks, MCP tools, UI copy, docs, e2e. No users exist; no compatibility anywhere. (`subshells.harness_id` already exists and remains the source of truth for the harness; the row's `profile_id` becomes nullable `preset_id`.)
2. **"No preset" is a real launch**, not a mapping onto a seeded row. The Default seeding, `is_default`, the undeletable guard, and the uninstall special case are deleted. A fresh instance has zero presets and can launch immediately.
3. **The node pin is removed.** `presets.node_id` dies with it: the pin was the main source of the launch form's state machine (`suggestDecision`, `nodeExplicit`, the earned-suggestion gates) and of the web/mobile divergence, and with the agent chosen first, node compatibility is decided by the agent, with the node picker's own default rules unchanged.
4. **The new-subshell dialog asks its own question**: Agent → Preset (default **None**, with a `+` that opens an inline create dialog with the agent locked) → Node (hide-when-sole-target, unchanged) → Working directory.
5. **"Preset" replaces "Profile" as the user-facing word** — the account-page collision dies with the rename.
6. **Mobile lands in the same cut** (its New screen mirrors the launch picker; API-shape changes must not break it).

## 3. Why the rename is the fix, not a coat of paint

Renaming without making the row optional would keep every piece of machinery and change only the label. Making the row optional is what deletes the seeding, the flag, the guard, the impact clause, and the `(harnessId)` suffix on every launch option — and it collapses the concept to one sentence: **a preset is saved launch settings for one agent; you can always launch without one.** The empty launch (`no preset`) is not a special case in the pipeline: it is one `EMPTY_PRESET` definition (`{ name: "", env: {}, flags: [], settings: null, configIsolation: false }`) fed to the same `buildCommand` path, and no plugin reads `preset.name` or `preset.description` at launch (verified across all six built-ins), and `assembleHarnessCommand` reads only `.env` — an empty preset contributes nothing, which is exactly right.

## 4. Contract (the frozen surface every client codes against)

- `GET/POST/PUT/DELETE /api/presets` — same shape as `/api/profiles` minus `nodeId`/`isDefault`; response `PresetRow { id, harnessId, name, description, envJson, flagsJson, settingsJson, configIsolation, restartOnExit, createdAt, updatedAt }`. `POST` returns the created row. Cookie-only writes, bearer `envJson` redaction, `?harnessId=` and `?node=any` filters, `/api/presets/harness-ids`, `/api/presets/harnesses/:id/schema` — all carry over unchanged.
- `POST /api/subshells` body: `{ harnessId: string (required), presetId?: string, workingDir, name?, prompt?, nodeId? }`. A `presetId` that is absent/foreign 404s; one whose `harnessId` disagrees with the body 400s `preset_harness_mismatch`. Launch-node precedence loses the pin step: body → `local` → single-online-agent auto-pick.
- `GET /api/plugins` rows gain `type: "agent-harness" | "terminal"` (manifest data; the client default rule puts Terminal last). Plugin impact: `{ presets, distinctUsers, runningSubshells }` (no `defaults`); uninstall returns `presetsRemoved`.
- Admin status inventory field `profiles` → `presets`. Subshell views carry `presetId: string | null`.
- MCP: `list_profiles` → `list_presets`; `create_subshell` input `{ harness, preset?, name?, working_dir, prompt? }` — `harness` is a plugin id, `preset` an optional name resolved within that harness.

## 5. The launch form

- **Agent** options are the whole `GET /api/plugins` set, greyed never hidden (the 2026-09-02 rule, unchanged): reasons in precedence "not installed on this server" → "failed to load" → "disabled on this server" → node reasons ("node offline", "not installed on this node"). The default pick: the agent of the user's most recent subshell when usable, else the first usable non-terminal agent, else anything usable. `useSubshellsList()` already holds the data; no new request.
- **Preset** lists only the chosen agent's presets, with "None" first and selected. Changing the agent resets the preset to None. The `+` opens a nested `CreatePresetDialog` (Base UI supports nested dialogs natively; Escape closes the topmost) with the agent locked; on create, the new preset is selected. First run hides the row entirely — a new account has zero presets and the row would offer only "None".
- **Node / Working directory** unchanged, minus the pin suggestion. The densest effect in the SPA shrinks to: node re-home → working-dir pre-fill → agent default.

## 6. Data model and migration

One new migration (`0027-presets`): rename `profiles` → `presets` (no FK references it), re-create its index under the new name, drop `is_default` and `node_id`; on `subshells`, ADD `preset_id` → copy `profile_id` → DROP `profile_id` — never a table rebuild (`workspace_panes`/`subshell_shares` cascade on `subshells.id`, and `PRAGMA foreign_keys` cannot be turned off inside the migrator's transaction). Deleting a preset nulls `preset_id` on rows that used it (the node-delete unpin pattern), so their restart falls back to the empty preset instead of failing — restart already re-reads the row each time, so this matches "availability is computed, never stored" (spec 2026-09-10 §6.1).

## 7. Published-contract break (accepted)

`@subshell-ai/plugin-api` renames `ProfileDefinition`→`PresetDefinition`, `BuildCommandInput.profile`→`.preset`, `validateProfile`→`validatePreset`, `profileSettings`→`presetSettings`; `PLUGIN_API_VERSION` 1→2 (the loader checks members by name, so a v1 plugin is diagnosed, not silently accepted). The `launch` node frame carries `preset`, so `NODE_PROTOCOL_VERSION` 6→7 and `MIN_AGENT_VERSION` rises to the agent's new version — the repo's own bump rules. All six built-ins, the e2e fixture plugin, and both desktop apps ship in the same cut (a desktop cut re-ships its CLI; release as `app=all`).

## 8. What is NOT changed

- `harnessUsable`'s rule (instance installed∧enabled∧not-broken × node detection) — the Agent select greys with it, the server 409 stays the backstop.
- Cookie-only preset writes (preset env outranks the credential layer), env-key validation, `restartOnExit` inheritance, the "Edit preset → start again" dead-subshell recovery loop (shown only when the subshell has a preset), owner-only clone.
- Terminal staying a plugin option: it needed no profile before and needs no preset now.
- The `?node=any` list filter's purpose (pairing against a selected node's inventory) — it was never about the pin.

## 9. Testing

Migration round-trip + copy test; `presets-route` keeps the carried-over blocks and adds the null-out-on-delete case; launch without a preset 200s with `presetId: null` and empty-preset argv; MCP name-resolution cases rewritten; web unit tests for `buildAgentOptions`/`defaultAgentId`/form defaults/nested-create/first-run-hidden-preset; e2e canonical launch becomes `pickAgent("pi")` → leave None → fill dir → Start, and spec 04 becomes presets CRUD including inline create; `12/13` move their "greyed ≠ gone" assertions onto the Agent select.
