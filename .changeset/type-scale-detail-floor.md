---
"@internal/server": minor
"@internal/desktop-server": minor
"@internal/desktop-client": minor
---

Type is five roles, not six: the 12px `caption` was too small to read and has
been removed, so `detail` (13px) is the floor and carries what caption did —
chips, timestamps, versions, monospace output. Quiet text is separated from
loud text by colour and weight rather than by a third size. `lint:design`
refuses `text-xs` and `text-caption`, which matters because Tailwind still
generates `.text-xs` from its own defaults once the token is deleted.

Everything a control says about itself is now one size: its help text, a "set
by the environment" note, a saved-vs-running line, a validation error. Settings
→ Service explained a toggle at 13px and the field below it at 12px, and a
plugin's description was 12px in one card and 14px in another. Form labels also
gained the air under them they were meant to have — the label was `display:
inline`, which silently discards a vertical margin. The mobile app follows the
same scale.
