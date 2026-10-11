import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label } from "@internal/node-admin";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setTerminalFontSize, TERM_FONT_DEFAULT, terminalFontSize } from "@/lib/terminal-font-size";

const SIZES = [13, 15, 17, 19, 22];

/**
 * Account → the per-DEVICE terminal text size (see lib/terminal-font-size).
 * The deliberate alternative to iOS Safari's page zoom (the aA control):
 * a home-screen install that inherits a 115% page zoom renders its whole
 * layout into a shrunken viewport with a dead band below, while a larger
 * TERMINAL font costs only columns and changes nothing about the page.
 * Open terminals re-apply live via the {@link setTerminalFontSize} event.
 */
export function TerminalFontCard() {
  const [size, setSize] = useState<number>(TERM_FONT_DEFAULT);

  useEffect(() => {
    setSize(terminalFontSize());
  }, []);

  function choose(next: string | null) {
    if (next === null) return;
    setSize(setTerminalFontSize(Number(next)));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terminal text size</CardTitle>
        <CardDescription>
          Set the text size for all terminals on this device; open terminals resize immediately, and other devices keep
          their own settings. Larger text fits fewer columns, so use this setting and leave browser zoom at 100% to
          avoid shrinking the window in home-screen installs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex max-w-60 items-center gap-3">
          <Label htmlFor="terminal-font-size" className="shrink-0">
            Size
          </Label>
          <Select
            id="terminal-font-size"
            value={String(size)}
            onValueChange={choose}
            items={SIZES.map((n) => ({
              value: String(n),
              label: `${n} px${n === TERM_FONT_DEFAULT ? " (default)" : ""}`,
            }))}
          >
            <SelectTrigger id="terminal-font-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} px{n === TERM_FONT_DEFAULT ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
