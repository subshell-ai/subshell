---
"@internal/server": patch
"@internal/node": patch
---

A printed URL that wraps across terminal rows now behaves as one link, even after a page reload or on a phone. Attach replays carry the pane's soft wraps as seams instead of flattening them into hard newlines, so clicking (or tapping in copy mode) any row of a wrapped link opens the whole URL, and copying text over a wrapped line pastes one line with no newline spliced into the middle of it.
