---
"@internal/server": patch
"@internal/node": patch
---

Fix terminal input lag on nodes: keystrokes now echo as fast as they are typed instead of appearing only on a later key (Enter). The pane's live view is fed by `tmux pipe-pane`, whose child was `cat >> <log>`. On hosts where `/usr/bin/cat` is **uutils coreutils**, `cat` buffers a partial write to a regular file, so a keystroke echo — a tiny, newline-less write — never reached the log until an Enter-sized burst flushed it; the browser froze on the last flushed chunk. The capture child is now the binaries' own `pane-log --file <path>` verb, an unbuffered `readSync`→`writeSync` copy that flushes every read and creates the log 0600, identical on macOS and Linux and immune to which `cat` is installed. `subshell` and `subshell-server` both gain the verb; `cat >>` stays only as a no-child fallback. The earlier proxy/LAN-latency explanation was wrong — the keystrokes were arriving instantly; only the capture stalled.
