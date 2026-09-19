---
"@internal/server": patch
---

A subshell no longer gets named after a terminal capability query

Creating a subshell could name it `Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA` — the
Kitty graphics query agent CLIs emit at startup to ask whether images are
supported. A previous fix removed that query when its escape introducer was
present, but tmux stores a decoded pane title, so the payload can arrive with
the introducer already gone and nothing left to strip. It is now recognised by
shape as well, and a pane whose title is only that keeps the name it had.
