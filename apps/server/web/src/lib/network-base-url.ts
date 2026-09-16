import type { NetworkRow } from "@/types/network";

/**
 * The Networking page's one statement of where this server says it lives.
 *
 * The base URL is what passkeys bind to and what install commands bake, it
 * is ONE value, and the cards below each hand it addresses it might name —
 * so the page that shows the cards must also show the answer, with the two
 * facts an operator needs to read with it: WHICH NETWORK owns the address,
 * and the one the boot-time constants make unavoidable — a saved change is
 * not the running one until the restart. (The value is written on Server
 * Settings → Service; a publish only adds origins.) `running` comes from the
 * settings every request already reads; `saved` from the deployment view,
 * which knows both.
 */
export interface BaseUrlLine {
  /** The address this server is running AS right now */
  running: string;
  /** Which network's address list contains it, or null for loopback/none */
  runningOn: string | null;
  /** The saved value awaiting a restart, or null when nothing is pending */
  pending: string | null;
  /** Which network the pending address belongs to, when it belongs to one */
  pendingOn: string | null;
}

/**
 * Assemble the line, or null when there is no base URL to show yet.
 *
 * A `saved` that equals `running` is not pending — comparing raw strings is
 * right here because both halves come from the same stored value on the
 * server, and any re-spelling that would fool this comparison would fool the
 * restart detector beside it.
 */
export function baseUrlLine(
  running: string | undefined,
  saved: string | undefined,
  rows: NetworkRow[],
): BaseUrlLine | null {
  if (!running) return null;
  const pending = saved && saved !== running ? saved : null;
  return {
    running,
    runningOn: networkFor(running, rows),
    ...(pending !== null ? { pending, pendingOn: networkFor(pending, rows) } : { pending: null, pendingOn: null }),
  };
}

/** The network whose own address list carries this origin — that IS the proof. */
function networkFor(url: string, rows: NetworkRow[]): string | null {
  const origin = originOf(url);
  if (origin === null) return null;
  for (const row of rows) {
    if (row.status?.addresses.some((address) => originOf(address.url) === origin)) return row.name;
  }
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
