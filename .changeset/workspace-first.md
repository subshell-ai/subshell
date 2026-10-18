---
"@internal/server": minor
"@internal/docs": patch
---

Workspaces are now the default home for panes. Launches land as tabs in the workspace you're viewing (or a fresh one from the landing page), Split creates a real named workspace instead of a draft, and a workspace retires itself when its last pane is removed. The sidebar's Workspaces tree lists each workspace's panes with an Ungrouped section for sessions that live in none, and opening the app returns to the workspace you were last in. Drafts, the discard sweep, and the unsaved/saved split are gone: `GET /api/workspaces` now carries every workspace with its panes, adding a pane twice is idempotent, and `POST /api/subshells` accepts a `workspaceId`. Migration 0058 drops the draft column and adds the unique pane constraint.
