import { Button } from "@internal/node-admin";

/** Read failures never masquerade as an empty permission or trust list. */
export function SshQueryStatus({
  query,
  label,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  label: string;
}) {
  if (query.isError)
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-destructive text-detail">Could not load {label}.</p>
        <Button variant="outline" className="self-start" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" className="text-detail text-muted-foreground">
        Loading {label}…
      </p>
    );
  return null;
}
