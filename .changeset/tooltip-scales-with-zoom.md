---
"@internal/server": minor
---

The sidebar's subshell-row tooltip is now a real in-page popup, so it scales with browser zoom. It used to ride the element's native `title`, which the browser paints at the SYSTEM font size; ctrl +/- grew the rail and left the reveal behind. The tooltip is the shadcn Base UI component, attached through its `render` prop so the row stays one element (nav, drag source, context-menu subject and tooltip trigger all on the same `Link`); a keyboard-focused row shows the same reveal, which `title` gave only on hover. The styled tooltip's text went one step up the scale, 13 to 14.
