# Brand assets

Standalone package (`@internal/brand`) deliberately outside the turbo task flow —
its scripts are named `make`/`check` so `turbo run test|generate` never picks them
up. Root aliases: `bun run brand:generate`, `bun run brand:test`.

`bun run brand:generate` rasterizes `src/*.svg` masters into the committed PNGs
(`apps/frontend/public/icons/`, `docs/assets/`, and each desktop app's
`src-tauri/icons/app-icon.png`).

**The two desktop apps differ only in their icon background**, and that is a
table in `generate.ts` (`DESKTOP_APPS`), not two copies of the artwork: one mark,
one geometry, one colour per app, swapped into the `<rect id="bg">` of
`tile-rounded.svg`. Both colours are taken off the UI palette in
`apps/frontend/src/styles.css` rather than picked by eye — the server uses
`--background` and the node app the accent hue at a mid lightness, so they differ
in hue AND lightness and stay apart when scaled to a 22pt menu-bar icon.

This script emits the 1024px MASTER only. The platform icon set (`.icns` and the
sized PNGs) is cut from it by tauri, which each app runs itself:

```bash
bun run brand:generate                       # the masters
bun run --cwd apps/desktop-server icons      # the icon sets
bun run --cwd apps/desktop-client icons
```

Those `icons` scripts also delete the Windows, iOS and Android assets
`tauri icon` emits unasked — neither app targets any of them, and leaving them
in the tree implies support that does not exist.

Requires the licensed font. The search order is per-OS — `~/Library/Fonts` and
`/Library/Fonts` on macOS, `~/.local/share/fonts`, `~/.fonts` and the system
dirs on Linux, then `~/fonts/acherus` everywhere — so installing the family the
normal way for your platform is enough. `SUBSHELL_BRAND_FONTS_DIR` overrides
the search entirely. (`loadSystemFonts` stays **false** in the renderer: finding
the file by convention is not the same as letting resvg substitute a fallback
face, which would silently produce output that looks almost right.)

- Everything is Acherus Grotesque **Light 300** (revised from Thin 100 on 2026-09-03 — Thin read too weak in the UI); the `/s` mark compensates for hairline
  rasterization by filling ≈⅔ of the tile (operator choice, 2026-09-02).
- The masters contain live `<text>` (family name only). **Never** commit the OTFs, never
  ship them as a webfont, never produce outlined SVGs — the license forbids it.
- Never hand-edit the PNGs; edit masters or the `JOBS` table and regenerate.
- Scale/step-down rules and exact colors:
  `docs/superpowers/specs/2026-09-02-subshell-branding-design.md`
