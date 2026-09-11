import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

/**
 * Gives bun:test's `expect(...)` the jest-dom matcher types (`toBeDisabled`,
 * `toHaveAttribute`, …). The matchers themselves are wired into the runtime
 * `expect` by `src/test-setup-matchers.ts` (a bunfig.toml preload); this file
 * only makes `tsc` aware of them, via the declaration-merging hook bun-types
 * documents on `bun:test`'s own `Matchers`/`AsymmetricMatchers` interfaces.
 */
declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers<unknown, void> {}
}
