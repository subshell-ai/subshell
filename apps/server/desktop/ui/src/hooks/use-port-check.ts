/**
 * The port check, as the hook the plan named (spec 2026-09-21; plan Task 6).
 *
 * Lifted out of `host.tsx`, where it lived inline since Task 2, when its first
 * consumer — the address form — landed. The state is the page's (both screens
 * that edit addresses read the same answer), so the hook is used once, in the
 * host, and the pieces ride down as props.
 *
 * `checkPort`'s superseded-answer drop is the part that was ABOUT the answers,
 * and it is preserved exactly: a newer check drops the older one's answer. The
 * old page's "never redraw under a hand typing" gate is gone structurally — a
 * React re-render is reconciliation, and controlled inputs keep their text and
 * cursor, so the answer can land whenever it arrives.
 */
import { useCallback, useRef, useState } from "react";
import * as ipc from "../lib/ipc";

export function usePortCheck(): {
  /** The last port this page asked about, and the answer for it. */
  portCheck: { port: string; inUse: boolean } | null;
  /** Ask about one port, unless that answer is already in hand or on its way. */
  checkPort: (port: string) => void;
} {
  /**
   * The last port this page asked about, and the answer for it.
   *
   * Not a probe field: the probe reports the MACHINE, and this reports a
   * number the person may be typing into the address form, which changes
   * without the machine changing. Keyed by the port so an answer is only ever
   * read back for the port it was measured on.
   */
  const [portCheck, setPortCheck] = useState<{ port: string; inUse: boolean } | null>(null);
  /**
   * The port the newest check was fired for.
   *
   * It does two jobs: one render's question is asked once, and an answer that
   * arrives after a newer check was fired is DROPPED — two loopback connects
   * race, and the slower one is the older question. A ref rather than state:
   * it is a guard on in-flight answers, never something to render.
   */
  const portAsked = useRef<string | null>(null);

  const checkPort = useCallback(
    (port: string): void => {
      if (portCheck?.port === port || portAsked.current === port) return;
      const numeric = Number(port);
      // A port that is not a port is the CLI's refusal to make, not this
      // check's: `u16` would reject the invoke outright, and the config form
      // already shows the server's own complaint about the value. Cached as
      // free so the gate opens and the chain gets to report what is actually
      // wrong.
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
        setPortCheck({ port, inUse: false });
        return;
      }
      portAsked.current = port;
      const asked = ipc.portInUse(numeric);
      asked
        // A refused command is not a busy port. The page has no way to tell
        // them apart and only one of them is safe to assume, so a failed
        // check reads as free and the chain reports the bind failure itself.
        .catch(() => ({ inUse: false }))
        .then(({ inUse }) => {
          // Superseded: the field moved on while this was in flight, and the
          // answer is about a port nothing is asking about.
          if (portAsked.current !== port) return;
          setPortCheck({ port, inUse });
        });
    },
    [portCheck],
  );

  return { portCheck, checkPort };
}
