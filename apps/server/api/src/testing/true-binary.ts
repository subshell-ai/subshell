import { existsSync } from "node:fs";

/**
 * Absolute path to a real `true(1)` — an executable that exists, does nothing
 * and exits 0.
 *
 * Tests use it as a stand-in harness binary: `CLAUDE_PATH` and friends are
 * resolved by `findBinary`, which only asks whether the path is an executable
 * file, so any such binary makes a harness "installed" without shipping a CLI.
 *
 * The path is NOT portable and must not be hardcoded. `/bin/true` exists on
 * Linux but NOT on macOS, where coreutils' `true` lives at `/usr/bin/true`;
 * hardcoding it made every affected harness report not-installed on a Mac, so
 * presets were filtered out of `GET /api/presets` as "unavailable" and
 * preset writes answered 409 `harness_unavailable`. Ten assertions across
 * three files failed on macOS and passed in CI, which reads as flakiness
 * rather than as the platform difference it is.
 */
export const TRUE_BINARY: string = ["/usr/bin/true", "/bin/true"].find((p) => existsSync(p)) ?? "/usr/bin/true";
