import { useState } from "react";
import { harnessToggleErrorMessage, useSetHarnessEnabled } from "@/hooks/use-harnesses";

/**
 * The harness enable/disable affordance — the setup wizard's (the settings
 * page's global harness card is gone — harness state is edited per node,
 * `/nodes/:id`). The wizard used to re-type the identical per-row error map
 * plus the mutate-with-onError wrapper around `useSetHarnessEnabled`; this is
 * that logic once. The presentation stays on the screen via `HarnessRow`.
 * @returns `toggle` flips one harness, `errors` maps harness id → the last
 * toggle failure ("" once retried), `pending` is true while any toggle call
 * is in flight (the wizard uses it to disable every switch at once, as it
 * always has)
 */
export function useHarnessToggles() {
  const setEnabled = useSetHarnessEnabled();
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Flips one harness; its previous error (if any) clears before the call. */
  function toggle(id: string, enabled: boolean) {
    setErrors((prev) => ({ ...prev, [id]: "" }));
    setEnabled.mutate(
      { id, enabled },
      { onError: (err) => setErrors((prev) => ({ ...prev, [id]: harnessToggleErrorMessage(err) })) },
    );
  }

  return { toggle, errors, pending: setEnabled.isPending };
}
