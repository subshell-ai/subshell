import { errMessage } from "@internal/node-admin";
import { useEffect, useState } from "react";

/** Arguments for {@link useBooleanSetting}. */
export interface BooleanSettingOptions {
  /** Reads the stored value once on mount; must be a stable reference. */
  get: () => Promise<boolean>;
  /** Writes a new value and resolves with what the server persisted. */
  set: (on: boolean) => Promise<boolean>;
  /**
   * What a failed probe falls back to. The account switches default their
   * features ON, so the fallback is ON too: a flaky read must never render a
   * false "Off" that makes a person think they opted out.
   */
  fallbackOn?: boolean;
  /** Fallback line shown when the write refuses and carries no message. */
  errorMessage: string;
}

/** The live state a boolean-settings card renders from. */
export interface BooleanSettingState {
  /** null until the probe answers; the switch stays inert and reads Unknown. */
  enabled: boolean | null;
  /** A write is in flight. */
  busy: boolean;
  /** The last refused write, rendered as an alert until the next attempt. */
  error: string | null;
  /** Optimistic flip: move now, adopt the server's echo or roll back. */
  toggle: () => Promise<void>;
}

/**
 * The state machine behind an account-wide boolean settings card, extracted
 * from the notifications master switch this replaced two copies of: probe
 * once, inert-until-answered, optimistic toggle with rollback and a visible
 * refusal. Callers inject their own endpoints (the cards' props keep the
 * read/write cycle testable without stubbing fetch), and `get` must be a
 * module-level stable reference so the load effect does not refetch every
 * render.
 */
export function useBooleanSetting({
  get,
  set,
  fallbackOn = true,
  errorMessage,
}: BooleanSettingOptions): BooleanSettingState {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    get()
      .then((on) => live && setEnabledState(on))
      .catch(() => live && setEnabledState(fallbackOn));
    return () => {
      live = false;
    };
  }, [get, fallbackOn]);

  async function toggle() {
    if (enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    setEnabledState(next);
    try {
      setEnabledState(await set(next));
    } catch (err) {
      setEnabledState(enabled);
      setError(errMessage(err, errorMessage));
    } finally {
      setBusy(false);
    }
  }

  return { enabled, busy, error, toggle };
}
