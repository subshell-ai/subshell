/**
 * POSIX single-quote a string for embedding into a shell command line.
 * Canonical quoter for everything that EXECUTES: the backend bakes pane
 * commands with it and harness plugins render operator-facing commands, so a
 * fix here (edge cases, escaping) reaches both by construction. The frontend
 * keeps a display-only twin (quotePosix in lib/launch-command.ts) because it
 * cannot import this package.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
