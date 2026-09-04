# Swipe prev/next between subshells (mobile)

Date: 2026-09-04 · Status: awaiting Theo review (written autonomously — Theo delegated
decisions and stepped away) · Surface: `apps/frontend` only

## Problem

On a phone, moving between two subshells costs three taps: back arrow → home/drawer →
row. The sidebar recents already impose a meaningful order (status band, then recency);
the single-subshell page should let you walk that order with a thumb.

## Decision

**Swipe left = next (down the list), swipe right = previous**, on the
`/subshells/$id` page only. Touch gestures only; no mouse/trackpad drag; nothing changes
in the workspace view — the prior decision there (xterm owns horizontal touch-drag for
selection, `workspace-tabs.tsx` §comment) stands.

- **Library: `@use-gesture/react@10.3.1`** (pinned). Theo's standing preference is
  vetted libraries over hand-rolled gestures; use-drag gives us the pointer state
  machine (touch-only filter, tap filter, direction, movement, pointer capture) without
  re-solving xterm's event soup by hand. The listener binds in the **capture** phase on
  the page wrapper — same reason `gateTouchKeyboard` captures: xterm's own handlers and
  their `preventDefault`/`stopPropagation` can't starve a sibling listener.
- **Order = `sortByStatus(useSubshellsList())`** — exactly what the sidebar rows are
  built from (`app-sidebar.tsx:136`). But the swipe walks the **full** sorted list, not
  the sidebar's `RECENT_LIMIT`-8 slice: a subshell ranked 9th still needs neighbours,
  and the order between rows is identical either way.
- **Geometry**: trigger on drag end when `|dx| ≥ 70px` AND `|dx| > 1.3·|dy|` (the slop
  keeps vertical scroll/`attachTouchScroll` untouched). Gestures starting within 24px of
  the left/right viewport edge are ignored — that strip belongs to the browser/OS
  back gesture. A commit is also skipped while the page holds a text selection
  (iOS selection-extension drags can satisfy the geometry — code review, 2026-09-04),
  and the follow-finger transform only animates in the committable regime.
- **Feedback**: damped follow-finger (`translateX = dx × 0.25`, cap ±48px) on the
  terminal wrapper while dragging, spring-free reset on cancel; skipped entirely under
  `prefers-reduced-motion`. On commit the route changes — no exit animation (the next
  page is a fresh mount; animating a terminal out invites a flash).
- **Exclusion zones**: the gesture lives on the terminal wrapper only — the header and
  the `TerminalKeyBar` are siblings outside it, so drags starting there never reach it.
- Ends of the list: the nearest neighbour is undefined → the drag springs back, nothing
  happens. SSE can reshuffle the order mid-view; neighbours are recomputed at drag end,
  never cached.

## Shape

- `src/lib/subshell-neighbors.ts` — pure `findNeighbors(ordered: {id}[], id)` →
  `{ prev, next }` (ids or null). Unit-tested directly (happy-dom needs no gestures for
  this).
- `src/hooks/use-ordered-subshells.ts` — the one definition of `sortByStatus(list)`
  shared by the sidebar and the swipe hook (dedup rule; sidebar keeps its own search
  filter + slice on top).
- `src/lib/swipe-nav.ts` — pure pieces, unit-testable without a browser:
  `swipeIntent({ dx, dy, startX, viewportWidth })` → `"prev" | "next" | null`
  (threshold + axis-slop + edge-guard in one place). (happy-dom's pointer-event support
  is too thin to drive use-drag itself — same stance as
  `directory-picker-input.test.tsx`.)
- `src/hooks/use-swipe-nav.ts` — generic `useSwipeNav(ref, { onNext, onPrev, enabled })`
  over `useDrag`: touch-only, capture-phase, calls `swipeIntent` on drag end and applies
  the damped transform during drag.
- `subshells_.$id.tsx` — wrap the terminal `<div className="relative flex-1 …">` in the
  swipe zone, feed it `findNeighbors` over the ordered list, navigate via the existing
  `useNavigate`.

## Error handling

- List not loaded / current id absent (just created, SSE lag): neighbours are null →
  swipe is inert.
- Navigating to a subshell deleted mid-swipe: lands on the existing
  `SubshellNotFoundCard` — no new path.

## Setting (added after Theo's on-device confirmation)

Per-device opt-out, **default on**: `lib/swipe-nav-pref.ts` (localStorage
`subshell.swipeNav`, private-mode-safe like `terminal-font-size`) surfaced by
`SwipeNavCard` under **Preferences → This device**. `/subshells/$id` reads it
at mount and folds it into `useSwipeNav`'s `enabled` — no live event needed,
since the switch lives on a page where no terminal is mounted and returning
remounts the terminal page.

## Out of scope

Workspace tabs/dock, the sheet drawer's swipe-to-close, apps/mobile (Expo), keyboard
prev/next, desktop pointer drag.

## Verification

Unit tests for `findNeighbors` + `swipeIntent` (`src/lib/__tests__/`); e2e
`tests/09-mobile-swipe.spec.ts` drives REAL touch events (CDP
`Input.dispatchTouchEvent`) in the iPhone-15-Pro Playwright project against the
:3199 stack — two live subshells, swipe down-list then up-list, URL asserted per
jump, plus zero-`pageerror` (guards the 09-mobile-navcrash live-to-live crash
territory); `bun run verify-types && bun run lint:check && bun run test` all
green. On-device feel (thresholds, damping) still worth a thumb pass on a real
phone.
