import { useState } from "react";
import { harnessInstallErrorMessage, useSetHarnessInstalled } from "@/hooks/use-harnesses";

/**
 * The setup wizard's install/remove affordance for the control-plane host.
 *
 * Was enable/disable until phase 2b; what the wizard asks is now "which of
 * these do you want installed here", and the answer is a plugins directory
 * rather than a flag. The per-node version lives on `/nodes/:id`.
 * @returns `toggle` installs or removes one plugin, `errors` maps id → the
 * last failure ("" once retried), `pending` is true while any call is in
 * flight (the wizard uses it to disable every switch at once, as it always
 * has)
 */
export function useHarnessToggles() {
  const setInstalled = useSetHarnessInstalled();
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Installs or removes one plugin; its previous error clears before the call. */
  function toggle(id: string, installed: boolean) {
    setErrors((prev) => ({ ...prev, [id]: "" }));
    setInstalled.mutate(
      { id, installed },
      { onError: (err) => setErrors((prev) => ({ ...prev, [id]: harnessInstallErrorMessage(err) })) },
    );
  }

  return { toggle, errors, pending: setInstalled.isPending };
}
