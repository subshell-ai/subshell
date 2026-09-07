---
"@internal/desktop-client": minor
---

**Fixed: node management could become unreachable.** Once a control plane
address was settled, startup opened only the plane window and the node window's
only route back was the tray — which is silently invisible on any Linux desktop
with no StatusNotifier host (a stock GNOME), and on a notched Mac whose Control
Center has wedged. Enrolment, agent installation and service control were then
unreachable, and relaunching did not help.

Three routes now exist, and the app picks by asking rather than assuming:

- macOS gets **Window → This machine…** in the menu bar, which is always drawn.
- Where the tray probe says no icon would render, the node window opens at
  startup alongside the plane instead of waiting to be summoned.
- Relaunching re-creates it there, so the recovery the tray notes have always
  prescribed actually works.

**Fixed: switching control planes silently did nothing.** The plane window's
navigation guard was pinned to the origin the window was BUILT with, and a
`navigate()` to a different plane goes through that same guard — so the switch
was refused, the old plane stayed on screen, and the command that asked for it
reported success. The pin now follows a deliberate switch while still refusing a
redirect, an href in rendered content, or an injected script.

**Added: a way to change the plane.** The address is filled in automatically
from an existing enrolment, so without this a machine enrolled against one plane
could never be pointed at another from the app — and a typo'd-but-valid address
was equally permanent.
