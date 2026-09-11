/**
 * Bun test preload, second in `bunfig.toml`'s order: wires jest-dom's DOM
 * matchers (`toBeDisabled`, …) into bun:test's `expect`. jest-dom's own
 * package auto-registers against a Jest/Vitest global `expect`, which
 * bun:test has none of, so the standalone `/matchers` entry point is used
 * and extended by hand instead.
 *
 * Kept in its OWN file, after `test-setup.ts`, rather than folded into it:
 * this import pulls in `@testing-library/dom` transitively, whose `screen`
 * singleton is built at module-eval time from whatever `document` currently
 * is. Importing it before `test-setup.ts` has registered happy-dom's globals
 * would permanently poison `screen.getByRole`/etc. for every test file in the
 * run — see the comment in `test-setup.ts`.
 */
import { expect } from "bun:test";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

expect.extend(jestDomMatchers);
