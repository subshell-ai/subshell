# Brand assets

`bun run brand:generate` rasterizes `src/*.svg` masters into the committed PNGs
(`apps/frontend/public/icons/`, `docs/assets/`). Requires the licensed font at
`~/fonts/acherus/Acherus-Grotesque-Thin.otf` (or `SUBSHELL_BRAND_FONTS_DIR`).

- Everything is Acherus Grotesque Thin 100; the `/s` mark compensates for hairline
  rasterization by filling ≈⅔ of the tile (operator choice, 2026-09-02).
- The masters contain live `<text>` (family name only). **Never** commit the OTFs, never
  ship them as a webfont, never produce outlined SVGs — the license forbids it.
- Never hand-edit the PNGs; edit masters or the `JOBS` table and regenerate.
- Scale/step-down rules and exact colors:
  `docs/superpowers/specs/2026-09-02-subshell-branding-design.md`
