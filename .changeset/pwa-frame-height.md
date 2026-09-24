---
"@internal/server": patch
---

Fix the PWA frame ending short of the viewport in a home-screen install: the shell now pins its height to `window.innerHeight` (iOS computes `dvh` there as if Safari's collapsed toolbar existed, wrong until a rotation), and the shell's bottom safe-area padding — meant for the scrolling pages — no longer stacks under the terminal's own bottom-bar padding on the pages that own their bottom edge, which left a dead band beneath it.
