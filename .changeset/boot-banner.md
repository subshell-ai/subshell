---
"@internal/server": patch
---

Print the `/subshell` wordmark at boot, above the version line.

Plain ASCII — `#` draws `/sub`, `+` draws `shell`, so the wordmark's two-tone
split survives a journal, a piped log, or a terminal without truecolor. In a
terminal it additionally carries the brand's own colours, read from
`brand/src/wordmark.svg`: the slash's gradient, then `sub`, then `shell`.

Colour is emitted **only when stdout is a TTY**. Under systemd or launchd it is
not, and escape codes committed to a journal are something an operator has to
read around forever.

It reaches stdout through a LogLayer group bound to its own unprefixed
transport, so the banner is not stamped with `[time] INFO` — which would shear
the top row off the letterforms — without putting an unmanaged `console` writer
back into a codebase that routes everything through LogLayer.

Also fixes `bun run brand:generate`, which looked for the licensed font only at
`~/fonts/acherus` (one maintainer's Linux layout) and so refused to run for
anyone who had installed the family the normal way for their OS. It now
searches the platform's real font directories, with `SUBSHELL_BRAND_FONTS_DIR`
still overriding.
