import { Card, CardContent } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";

/** A shared loading state occupying the same card surface as the list. */
export function LoadingCard({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="flex min-h-40 items-center justify-center p-6">
        <div
          role="status"
          className="flex flex-col items-center gap-3 text-center font-strong text-heading text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="size-8 motion-safe:animate-spin" />
          <span>{message}</span>
        </div>
      </CardContent>
    </Card>
  );
}
