/**
 * Renders a `subshellRowTooltip` string as its own block per line with the
 * `Label:` part bolded.
 *
 * The tooltip's string form is kept (it is the tested contract, and rows and
 * cells share it); this is presentation only: the FIRST ": " on a line
 * belongs to our own label constants (`Name:`, `Node:`, `Agent:`, `Preset:`,
 * `Status:`, `Directory:`), so splitting there can never bold a value's
 * content — a path or a name may itself contain ": " and stays whole. A
 * line with no label renders as-is rather than being skipped: the renderer
 * never drops data it does not recognise.
 */
export function TooltipLabelledLines({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line) => {
        const split = line.indexOf(": ");
        return (
          <span key={line} className="block">
            {split === -1 ? (
              line
            ) : (
              <>
                <span className="font-strong">{line.slice(0, split + 1)}</span>
                {line.slice(split + 1)}
              </>
            )}
          </span>
        );
      })}
    </>
  );
}
