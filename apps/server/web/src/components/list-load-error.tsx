import { ExplainedButton } from "@internal/node-admin";
import { ErrorBanner } from "@/components/error-banner";

/** Keep failed list requests distinct from an empty search, with an explicit retry. */
export function ListLoadError({ message, retry, busy }: { message: string; retry: () => unknown; busy: boolean }) {
  return (
    <ErrorBanner
      message={message}
      action={
        <ExplainedButton
          type="button"
          className="rounded px-2 py-1 text-detail underline hover:bg-accent"
          disabled={busy}
          disabledReason="Wait for the current request to finish."
          onClick={() => void retry()}
        >
          {busy ? "Retrying…" : "Retry"}
        </ExplainedButton>
      }
    />
  );
}
