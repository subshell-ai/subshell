---
"@internal/node": minor
---

`subshell setup` is the whole enrollment in one command: it checks tmux, enrols
the machine, then asks whether to run the agent in the background and start it
at login (default yes, `--no-service` to skip), and ends by naming the node's
page on the control plane.

The installer one-liner now invokes it, installs to `~/.local/bin/subshell`
rather than the directory you happened to run `curl` from, checks tmux before
downloading, and reattaches the terminal so the question can be answered from a
piped install. It no longer ends by recommending `subshell run`, a foreground
process that dies with the SSH session and was the only next step the product
ever offered.

`enroll` remains the primitive underneath, and its closing line — like the
offline line in `status` — now names the service verbs before `run`.
