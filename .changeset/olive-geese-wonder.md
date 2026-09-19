---
"@internal/desktop-client": minor
---

Subshell Client's updater now behaves like Subshell Server's

Three things the sibling app fixed and this one never got. The tray's update
notice is a sentence — **Update available — Subshell Client 0.9.0** — instead
of a suffix tacked onto the request, so a person running both apps meets one
grammar. It can no longer announce a version you already run: every place that
paints the stored answer without re-asking the release source now filters it,
which a hand-replaced bundle used to defeat. And installing an update clears
that stored answer before the app relaunches, so the tray stops offering the
version you just installed.

The update screen's footer also ends on a filled button at the bottom right,
where every other screen's does, instead of a faint one at the left.
