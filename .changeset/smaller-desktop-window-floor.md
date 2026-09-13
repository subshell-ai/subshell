---
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Both desktop apps can now be resized down to 360×240 — a third of the old 1024×640 minimum. That floor existed so the window could never fall below the web UI's 1024px breakpoint and render its narrow, phone-style chrome; the cost was a window too big to park in a corner beside an editor, which is a normal thing to want from a terminal. The narrow layout is a designed one, so crossing that breakpoint is now the user's call. The floor still scales with the app's text size, so the window stays as usable at 200% as at 100%.
