import { Button, errMessage } from "@internal/node-admin";
import { NodeKeySetup } from "@/components/nodes/node-key-setup";
import { SshQueryStatus } from "@/components/ssh/query-status";
import { FieldGroup } from "@/components/ui/field";
import type { useSshEnrollment } from "@/hooks/use-ssh-enrollment";
import { NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import type { SshMachineReadiness } from "@/lib/ssh";

/** Embedded enrollment fields; matching the consumed key and live node are separate facts. */
export function SshEnrollmentStep({
  enrollment,
  mayAdd,
  machines,
  readiness,
}: {
  enrollment: ReturnType<typeof useSshEnrollment>;
  mayAdd: boolean;
  machines: SshMachineReadiness[];
  readiness: { refetch: () => unknown };
}) {
  return (
    <FieldGroup>
      {!mayAdd && !enrollment.created ? (
        <p className="text-detail text-muted-foreground">{NODE_ENROLLMENT_OFF_COPY}</p>
      ) : (
        <NodeKeySetup
          keyText={enrollment.created?.key ?? null}
          chosenAddress={enrollment.address}
          onAddressChange={enrollment.setAddress}
          chosenMethod={enrollment.method}
          onMethodChange={enrollment.setMethod}
          generate={
            <>
              <Button
                type="button"
                disabled={!mayAdd || !!enrollment.created || enrollment.create.isPending}
                onClick={() => void enrollment.generate().catch(() => {})}
              >
                {enrollment.create.isPending
                  ? "Generating setup key…"
                  : enrollment.created
                    ? "Setup key generated"
                    : "Generate setup key"}
              </Button>
              {enrollment.create.isError && (
                <p role="alert" className="text-destructive text-detail">
                  {errMessage(
                    enrollment.create.error,
                    "The setup key could not be generated. Retry Generate setup key.",
                  )}
                </p>
              )}
            </>
          }
        />
      )}
      {enrollment.created && (
        <>
          <SshQueryStatus query={enrollment.keys} label="setup key status" />
          <p role="status" className="text-detail">
            {enrollment.consumedNodeId
              ? machines.find((m) => m.node.id === enrollment.consumedNodeId)?.node.status === "online"
                ? "Machine enrolled and online. Continue to prepare SSH."
                : "Machine enrolled. Waiting for this machine to come online."
              : enrollment.row?.usedAt
                ? "This key was consumed without a matching machine. Retry its status or choose an existing machine."
                : "Waiting for this setup key to enroll a machine."}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void enrollment.keys.refetch();
              void readiness.refetch();
            }}
          >
            Retry enrollment status
          </Button>
        </>
      )}
    </FieldGroup>
  );
}
