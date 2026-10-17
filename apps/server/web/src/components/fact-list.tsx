import { Fact } from "@internal/node-admin";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";

/** Facts keep their values readable, including long paths and fingerprints. */
export function FactList({ rows }: { rows: { label: string; value: ReactNode; mono?: boolean; copyText?: string }[] }) {
  return (
    <dl className="grid min-w-0 gap-3 text-body">
      {rows.map(({ label, value, mono, copyText }) => (
        <Fact key={label} label={label} mono={mono}>
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{value}</span>
            {copyText !== undefined && <CopyButton text={copyText} label={label.toLowerCase()} />}
          </div>
        </Fact>
      ))}
    </dl>
  );
}
