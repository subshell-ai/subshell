import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

/** Optional field guidance and examples; keep warnings and status text at detail size. */
export function HelperCaption({ className, style, ...props }: ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={cn("text-detail text-muted-foreground", className)}
      style={{ ...style, fontSize: "calc(var(--text-detail) - 1px)" }}
    />
  );
}
