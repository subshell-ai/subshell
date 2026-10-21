import type { HTMLAttributes } from "react";

/** Compact form heading with a trailing rule, distinct from field labels without a caption. */
export function FormSectionTitle({
  as: Tag = "h3",
  children,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "h2" | "h3" | "legend" }) {
  return (
    <Tag
      {...props}
      className={["flex w-full items-center gap-3 font-strong text-label", className].filter(Boolean).join(" ")}
      style={{ ...style, fontSize: "calc(var(--text-label) + 1px)" }}
    >
      <span className="min-w-0">{children}</span>
      <span aria-hidden="true" className="min-w-6 flex-1 border-border border-t" />
    </Tag>
  );
}
