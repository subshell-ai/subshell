---
"@internal/desktop-server": patch
---

Four assistant fixes from the first-run report. The tmux gate now says "Waiting for tmux to be installed". On a Mac with no package manager, the Homebrew install steps show by default instead of hiding until the button is pressed. The Photos permission prompt is fixed: it never appeared on the installed app because PhotoKit's consent request was made off the main thread, and it is now dispatched to main. The permission buttons are short ("Allow", "Open Settings") with the row named in each button's accessible label.
