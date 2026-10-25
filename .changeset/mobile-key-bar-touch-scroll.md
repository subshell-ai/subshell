---
"@internal/server": patch
---

Fix the mobile key bar's scroll, page up/down, byte, and paste keys doing nothing under a real finger on iPhone. The bar cancels the button's pointer-down to keep the terminal focused, and WebKit then skips the click it would otherwise synthesize, so the action that rode `click` never ran. Buttons now act on pointer-up (which every browser delivers), a tap that pans off the button sends nothing, and a browser that still clicks sends once, not twice.
