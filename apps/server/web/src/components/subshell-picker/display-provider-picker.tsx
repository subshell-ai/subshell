import { Label } from "@internal/node-admin";
import { VIRTUAL_DISPLAY_PROVIDERS } from "@internal/subshell-protocol";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export function DisplayProviderPicker({
  id,
  value,
  onChange,
  providers,
  defaultProvider,
}: {
  id: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  providers: readonly string[];
  defaultProvider?: string;
}) {
  const name = (id: string) => VIRTUAL_DISPLAY_PROVIDERS.find((p) => p.id === id)?.name ?? id;
  // An echoed pick is there so a saved choice the caller's list happens not to
  // carry still renders its own row. A provider this package SHIPS is not in
  // that list by accident: the caller filtered it out because the selected
  // machine's OS cannot run it, and echoing it back would re-offer, and keep
  // launching with, the exact choice the gate removed. An id we do not ship
  // belongs to the node, we hold no fact about its platform, and it stays.
  const isBundled = (id: string) => VIRTUAL_DISPLAY_PROVIDERS.some((p) => p.id === id);
  const echo = value !== undefined && (providers.includes(value) || !isBundled(value)) ? [value] : [];
  const choices = [...new Set([...providers, ...echo])];
  // The trigger can only read as a row that exists: a pick that is not among
  // the choices (see above) displays as the node default rather than as a
  // blank field that quietly still carries the old id.
  const selected = echo.length > 0 && value !== undefined ? value : "node-default";
  const items = [
    { value: "node-default", label: defaultProvider ? `Node default (${name(defaultProvider)})` : "Node default" },
    ...choices.map((id) => ({ value: id, label: name(id) })),
  ];
  return (
    <div className="flex w-full flex-col gap-2">
      <Label htmlFor={id}>Display provider</Label>
      <Select
        items={items}
        value={selected}
        onValueChange={(v) => {
          if (v) onChange(v === "node-default" ? undefined : v);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
