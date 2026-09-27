---
"@internal/server": minor
---

The sidebar's Workspaces section grew up. It now has a search that filters every workspace (not just the eight it lists), splits the list into Saved and Drafts, and labels each draft by its creation stamp, so the unsaved workspaces a split leaves behind are visible and named instead of invisible. The Drafts header carries a trashcan that discards every unsaved workspace at once, sparing the one you are standing in, with a confirmation first. The rail's Workspace section (the panes of the workspace you are in) joins the machine groups, collapses on its own preference, and in flat mode the grid splits into Workspace and Others. Collapse/expand-all, the eye show-hide toggles, and the compact phone header all gained real tooltips, and two workspaces created in the same minute no longer collide: a second default name gains " (2)". Server-side, `GET /api/workspaces?drafts=only` and `DELETE /api/workspaces/drafts?except=` power the new section.
