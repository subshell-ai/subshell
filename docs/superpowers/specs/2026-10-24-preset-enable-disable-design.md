# Preset enable/disable design

Date: 2026-10-24
Status: approved (owner delegated the remaining decisions; the calls below are recorded)

## Intent and the why

A person who keeps many presets wants to stop offering one without deleting it —
maybe a preset is for a task they're done with this month, or one that no longer
matches how they launch. Today the only "get rid of it" is Delete, which is
permanent. This adds an **enabled/disabled** toggle on each preset row, for both
kinds of preset (agent and SSH), so a preset can be set aside and brought back.

## What "disabled" means

A disabled preset is **hidden from pickers entirely** and **refused at launch**.
It is not deleted, and it still appears in the `/presets` management table so it
can be re-enabled.

- **Hidden from pickers:** the agent launch form's preset picker, the SSH connect
  panel's preset picker, the "switch preset" dialog, MCP `list_presets`, and the
  mobile New screen's preset chips.
- **Refused at launch:** `POST /api/subshells` with a disabled agent `presetId`
  answers a coded refusal; the restart/swap path refuses the same way; MCP
  `create_subshell` refuses with a named error.
- **Still listed:** the `/api/presets` list keeps returning the row (with its
  `enabled` flag) so the management table can render the toggle. Only the picker
  surfaces filter.

## Goals / non-goals

- **Goals:** a per-preset, user-level enable flag on both tables; a `Switch` in
  each table row; disabled presets vanish from every launch surface; launching a
  disabled preset is refused.
- **Non-goals:** not a delete/archive; not tied to harness enable state (that
  gate already exists — presets of a disabled harness are already hidden by the
  store gate); not a per-share or per-node preference (it is a property of the
  row); import/export file format unchanged (`enabled` is a local preference, not
  a portable preset property; an imported preset always starts enabled).

## Data model

Add an `enabled` integer column to both tables, default 1 (enabled):

- `presets.enabled` (agent presets)
- `ssh_presets.enabled` (SSH presets)

One migration (`0062-preset-enabled`), guarded on column existence like its
neighbours (migrations are self-contained and re-run cleanly). `down` drops the
column. The 0/1 representation matches the existing preset flag convention
(`restartOnExit`, `configIsolation`, `crossCommEnabled`).

## API

- **Response:** `enabled: number` (0/1) added to `PresetSchema` and
  `SshPresetSchema`; the web/mobile types mirror it.
- **Toggle:** `PATCH /api/presets/:id` with body `{ enabled: boolean }`, applied
  to both kinds (mirrors the plugin grid's `PATCH /api/plugins/:id { enabled }`).
  Cookie-only, owner or edit-shared (view-shared → 403; absent/foreign → 404).
  This is the only write path for the flag; the SSH PUT's "send complete fields"
  contract is left alone.
- **Create:** defaults to enabled (1); no new create-body field needed.
- **List:** returns all rows (including disabled) with the `enabled` flag;
  bearer `envJson` redaction unchanged.

## Launch refusal

- `subshells.service.ts` `createSubshell` (the agent launch gate): a `presetId`
  whose row is disabled answers a coded refusal (same family as a missing
  preset).
- `subshell-manager.service.ts` restart/swap: the same check on the swap/relaunch
  path.
- MCP `create_subshell`: reads the preset row, and a disabled one is refused with
  a named error naming the remedy (re-enable it in the dashboard).

## Consumers that filter (pickers)

- `new-subshell-form.tsx` (agent launch picker): filter `enabled === 1`.
- `switch-preset-dialog.tsx`: filter `enabled === 1`.
- `SshPresetPicker` (connect panel): filter `enabled === 1`.
- MCP `list_presets`: exclude `enabled === 0` rows.
- Mobile New screen preset chips: filter `enabled === 1`.

## UI

- **Agent tab:** a new "Enabled" column in the agent preset table; `PresetTableRow`
  gets a `Switch` (only where the user can edit the preset, owner or edit-shared).
  Disabled rows render dimmed.
- **SSH tab:** a matching "Enabled" column and `Switch` in `SshPresetLibrary`.
- The toggle calls the `PATCH` and invalidates the preset caches.

## Review focus

- A preset disabled then re-enabled must reappear in the pickers without a reload
  (the toggle invalidates the cache).
- A disabled preset referenced by an in-flight `create_subshell` (or by a recent
  launch's auto-default) must not auto-apply; the default logic degrades to no
  preset.
- A disabled preset's row still opens its detail/edit page (viewing and editing
  are not picker acts), and its launch-command preview still renders.
- View-shared presets get no toggle and cannot be toggled by the viewer.
- Bearer/machine `list_presets` never offers a disabled preset, and the launch
  gate refuses one even if a client bypasses the picker.
