import type { CreatedSetupKey } from "@internal/node-admin";
import { useRef, useState } from "react";
import type { Method } from "@/components/nodes/node-key-setup";
import { useCreateSetupKey, useSetupKeys } from "@/hooks/use-nodes";

/** Lives for the open wizard, including Back; only its own consumed key proves enrollment. */
export function useSshEnrollment() {
  const create = useCreateSetupKey();
  const generating = useRef(false);
  const [created, setCreated] = useState<CreatedSetupKey | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("terminal");
  const keys = useSetupKeys(created !== null, created !== null);
  const row = keys.data?.keys.find((key) => key.id === created?.id);
  const consumedNodeId = row?.consumedNodeId ?? null;
  return {
    create,
    created,
    address,
    setAddress,
    method,
    setMethod,
    keys,
    row,
    consumedNodeId,
    generate: async () => {
      if (created || create.isPending || generating.current) return;
      generating.current = true;
      try {
        setCreated(await create.mutateAsync());
      } finally {
        generating.current = false;
      }
    },
  };
}
