# tabs

2026-08-30, deletion (not migration). Verdict: removed as dead code.

## Changed

- Deleted `src/components/ui/tabs.tsx`. `grep -rn "ui/tabs" src` shows zero
  importers: the workspace tab strip is the hand-rolled
  `src/components/workspace-tabs.tsx` (touch-first, no Radix), and nothing
  else uses shadcn Tabs.
- `@radix-ui/react-tabs` removed from package.json with it (nothing else
  imports the package).

## Left alone

- `src/components/workspace-tabs.tsx`: custom component, no Radix, not a
  shadcn Tabs consumer.

## Behavior changes

- None possible; the wrapper was unreachable. If a future feature needs
  tabs, fetch the Base-UI shadcn tabs component fresh.

## Verify by hand

- Workspace page in tab mode (narrow viewport) still renders its tab strip;
  proves nothing imported the deleted file indirectly.
