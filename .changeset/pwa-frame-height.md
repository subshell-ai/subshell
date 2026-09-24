---
"@internal/server": patch
---

Fix the PWA frame ending short of the viewport: in a home-screen install the shell now pins to `window.innerHeight` (iOS computes `dvh` as if Safari's collapsed toolbar existed, wrong until a rotation), and the scrolling pages' bottom safe-area padding no longer stacks under the key bar's own, which left a dead band beneath it.
