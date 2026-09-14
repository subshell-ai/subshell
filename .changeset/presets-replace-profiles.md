---
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Profiles are **presets** now, and the rename is the least of it. A preset is one agent's saved launch customisation — env, flags, settings, auto-restart — and it has one job now: it is OPTIONAL. Launching needs only an agent and a folder.

That optionality is what deleted the machinery. Every launch once required a row, which is why the server seeded a blank **Default** profile per user and per plugin at four seams and refused to delete it. A fresh instance now has zero presets and can launch immediately; every preset is deletable, and deleting one nulls the reference on the subshells that used it, whose next restart falls back to the plain launch rather than failing.

**Upgraded instances lose the seeded Default rows too.** Migration `0027` deletes every row the old seeder marked and frees the subshells that pointed at them, so an upgraded instance is presetless of Defaults exactly like a fresh one — a blank phantom preset beside the new "None" would resurrect the deleted concept. Every preset **you** created converts unchanged — including one you NAMED "Default": the purge hunts the seeder's flag, never the string. But an **edited seeded Default is removed WITH the seeded rows** — your customisation lived on a row the seeder flagged, and the flag is what marks it for deletion, not the text inside. Copy anything you need out of it before upgrading.

**A preset name is now unique per agent, per user, ignoring case.** It always claimed to be — `0001-init.ts` documented the invariant while the index enforced nothing — which is how an agent asking for a preset by name could get whichever row sorted first. Migration `0028` adds the real constraint, and create and rename answer 409 on a collision, the way workspace names already did. Existing duplicates are **renamed, never deleted**: the oldest keeps the name and the rest take " (2)", " (3)" in creation order, each keeping its own capitalisation. The only way to notice is if you were deliberately running two same-named presets for one agent — in which case they were already indistinguishable in every picker.

Presets no longer pin a node. The pin was the biggest part of the launch form's state machine and of the divergence between web and mobile; with the agent chosen first, node compatibility is decided by the agent, and the node picker's own default rules are unchanged.

Agents on the instance list presets through MCP (`list_presets`) and launch with `create_subshell` taking `harness` plus an optional `preset`.

**Enrolled nodes must update their agent.** The node protocol moves to 7 — the launch frame's `profile` field becomes `preset`, wire-shaped and not semantic — and the gate is exact-match, so a lagging agent is refused with a named version to install (the floor is 0.5.0). Both desktop apps ship in the same cut, re-bundling the CLI each wraps; cut the release as `app=all`. SPA work ships embedded in the server binary, which is why it has no changeset of its own.
