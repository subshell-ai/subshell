---
"@internal/desktop-client": minor
"@internal/server": minor
"@internal/node": minor
---

Subshell Client's first run asks what you came to do. It used to land on one screen
whose primary button read **Open**, which persisted the address *and* threw the server's
dashboard on screen while the setup carried on in the window behind it. Now: Welcome →
"What would you like to do?" → either **use this machine as a node** (tmux → the
registration details → how the node runs → a Setting Up… checklist) or **connect to a
server**. A configured client lands on a client-status screen on every launch
afterwards, where the dashboard is a button. The rule the whole flow exists for: this
app never opens the control plane's dashboard by itself.

The details screen says **Continue**, because that press spends nothing; the press that
installs the agent, enrols and starts the service is on the start-up screen, so that one
says **Register**. Nothing verifies the server or the key before it — a setup key is
single-use and `enroll` is the only operation that tests one, and an endpoint answering
"is this key good?" would be an oracle for guessing them — so the press checks the
answers' SHAPE and the checklist reports the rest.

A failed registration can be edited and retried. The failed act shows the CLI's own
words, **Edit details** goes back to the form with the server and name intact and the
spent key cleared, and a retry with the machine already registered resumes at the
service act rather than enrolling a second time. Enrolling over a live `config.json`
mints a second node row and discards the only copy of the node key, so the chain stops
and asks rather than doing it silently. Every walk screen has a way out, and a client
that was already configured returns to its status screen rather than to a choice it
never saw.

The tmux pane is the server's. tmux is a hard requirement for registration, and on a Mac
with no Homebrew the old screen could only refuse while telling you to run `brew`. It
now streams the package manager's own output with a clock, and offers Homebrew and
MacPorts where it cannot install for you. The node agent gained
`service install --no-autostart` to back the start-up choice — on macOS that is which
DIRECTORY the plist lives in, since launchd auto-loads only `~/Library/LaunchAgents`, so
`status`, `start`, `uninstall` and `update` learned to read both places.

A node's harness inventory refreshes itself: when the node comes online, and periodically
while it stays online. Detection used to fire only on a node-detail page load, a manual
Re-check, or a launch, so a machine that had just enrolled — or had a CLI installed on it
afterwards — carried a stale inventory until somebody opened its page.

The agent's log is the one you are shown. It was already capped at 200 KB and replaced
when full; what diverged was that the desktop revealed launchd's redirect instead, which
is appended to forever. Both surfaces name the same file now, and the launchd copy is
0600 rather than world-readable.

Two touch bugs on a phone, in the browser and in the app. A tap on the grid raises the
keyboard again — xterm 6 focuses its helper textarea only from `mousedown`, and its own
gesture layer cancels the touch that would produce one, so nothing was ever focused. And
a flick no longer types `NaN` into the pane: xterm reports momentum frames as wheel
events without coordinates, and those reports are now dropped on their way out while
well-formed ones still scroll.

And **Choose an existing agent…** is gone. It pointed at a `subshell` binary, but *agent*
already means an agent-harness plugin here, so the label offered to choose the wrong
thing entirely.
