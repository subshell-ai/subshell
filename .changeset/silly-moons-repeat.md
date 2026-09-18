---
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Both desktop apps now say so when a tmux install fails, and Subshell Server's
first run explains what macOS is about to ask.

A tmux install that failed reported one line — whatever the package manager's
stderr happened to end on — above a button that redrew exactly as it had been,
so it read as a press that had done nothing. An install that exited zero and
left no tmux said nothing at all. Both now render a failure card: the app's own
sentence about what happened, the manager's last word beside it, and the whole
run behind Show output. The button reads **Try again** and re-reads the machine
before it spawns anything, so coming back from a terminal where you installed
tmux yourself just works.

On macOS, Subshell Server's first run ends on the permissions screen — what
macOS will ask, and why — between "Subshell Server Is Ready" and the dashboard.
Nothing on it blocks, and it is shown once, on a first run only.
