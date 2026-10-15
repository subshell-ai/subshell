import { ApiError, apiPost, confirmAction } from "@internal/node-admin";
import type { SshLaunchRequest, SshLaunchResponse } from "@/lib/ssh";

/** A first connection can ask for trust; a changed identity must never take this path. */
export async function launchWithDestinationVerification(
  request: SshLaunchRequest,
  launch: (request: SshLaunchRequest) => Promise<SshLaunchResponse>,
): Promise<SshLaunchResponse | null> {
  try {
    return await launch(request);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "SSH_HOST_PIN_MISSING" || !request.keyHome) throw error;
  }
  const check = await apiPost<{ token: string; destination: string; fingerprint: string }>(
    "/api/ssh/verify-destination",
    {
      node: request.node,
      keyHome: request.keyHome,
      destination: request.destination,
      ...(request.expectedDestination ? { expectedDestination: request.expectedDestination } : {}),
    },
  );
  const accepted = await confirmAction({
    title: "Connect to this destination?",
    description: (
      <div className="flex flex-col gap-3">
        <p className="break-all">{check.destination}</p>
        <p>
          Subshell hasn’t verified this destination before. Continuing remembers its identity and blocks future
          connections if it changes.
        </p>
        <p>If you aren’t sure this is the right machine, cancel and check with its administrator.</p>
        <details>
          <summary className="cursor-pointer font-strong text-label">Verification details</summary>
          <p className="mt-2 text-detail">
            This identity came from the destination and hasn’t been independently verified. Its administrator can
            confirm this fingerprint:
          </p>
          <p className="break-all font-mono text-detail">{check.fingerprint}</p>
        </details>
      </div>
    ),
    confirmLabel: "Trust and connect",
  });
  if (!accepted) return null;
  await apiPost("/api/ssh/verify-destination/accept", { token: check.token });
  return launch(request);
}
