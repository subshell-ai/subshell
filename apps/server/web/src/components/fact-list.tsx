import { CopyableValue, Fact } from "@internal/node-admin";
import type { ReactNode } from "react";

/** One labelled fact: a small, bold label over a readable value, optionally copied. */
export interface FactRow {
  /** The small, bold label above the value; also names the copy button. */
  label: string;
  /** The value. Ignored when `copyText` is set, since the copy row shows that text itself. */
  value: ReactNode;
  /** Render the value in the mono voice, same size. */
  mono?: boolean;
  /** The exact text to copy, shown in full beside its copy affordance. */
  copyText?: string;
}

/**
 * Facts keep their values readable, including long paths and fingerprints.
 *
 * A copyable row renders through `CopyableValue`, the same affordance the
 * status cards and address lists use, rather than composing a bare
 * `CopyButton`: HTTP LAN pages have no Clipboard API, and the bare button
 * silently did nothing there where the shared row falls back to
 * select-and-copy.
 */
export function FactList({ rows }: { rows: FactRow[] }) {
  return (
    <dl className="grid min-w-0 gap-3 text-body">
      {rows.map(({ label, value, mono, copyText }) => (
        <Fact key={label} label={label} mono={mono}>
          {copyText !== undefined ? (
            <CopyableValue value={copyText} label={label} />
          ) : (
            <div className="min-w-0 [overflow-wrap:anywhere]">{value}</div>
          )}
        </Fact>
      ))}
    </dl>
  );
}
