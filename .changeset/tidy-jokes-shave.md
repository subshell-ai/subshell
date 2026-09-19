---
"@internal/server": patch
---

A new subshell is named after its agent, not the time you started it

An unnamed subshell used to be called `2026-08-18 14:30` until its agent
titled its own pane. It is now called **Claude Code**, **Terminal** — whatever
the agent is — which is the question you actually have while a pane is
starting. The agent replaces it with a real title within seconds, and renaming
still pins the name for good.

That also gives a rejected title somewhere sensible to land. Creating a
subshell could name it `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA` — the Kitty graphics
query agent CLIs emit at startup to ask whether images are supported. A
previous fix removed that query when its escape introducer was present, but
tmux stores a decoded pane title, so the payload can arrive with the introducer
already gone and nothing left to strip. It is now recognised by shape too, and
the row simply keeps the agent's name until a real title arrives.
