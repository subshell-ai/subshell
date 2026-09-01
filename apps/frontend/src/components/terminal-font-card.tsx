import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setTerminalFontSize, TERM_FONT_DEFAULT, terminalFontSize } from "@/lib/terminal-font-size";

const SIZES = [13, 15, 17, 19, 22];

/**
 * Settings → the per-DEVICE terminal text size (see lib/terminal-font-size).
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
          Text size for every terminal on this device — phones and desktops keep their own choice, and open terminals
          resize immediately. Bigger text fits fewer columns; leave the browser's own page zoom at 100% (a zoomed page
          shrinks the whole window on home-screen installs).
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
