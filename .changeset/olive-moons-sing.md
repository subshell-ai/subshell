---
"@internal/server": minor
---

Presets: auto-restart on by default, and the launch command is hidden until asked for

New presets start with **Auto-restart on exit** on. A preset exists because
someone means to run an agent that way more than once, so recovering from an
exit is the expected answer; the switch is unchanged and turning it off is one
click. Presets you already saved keep whatever they stored.

The `/presets` list no longer prints each preset's launch command. Those env
vars are where API keys and base URLs live, and the page is something you
scroll past on the way somewhere else — so each row now carries an eye icon
that reveals its own command, per visit, with nothing persisted. Copy still
works while it is hidden.
