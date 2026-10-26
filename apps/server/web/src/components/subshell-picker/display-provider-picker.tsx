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
  const choices = [...new Set([...providers, ...(value ? [value] : [])])];
  const items = [
    { value: "node-default", label: defaultProvider ? `Node default (${name(defaultProvider)})` : "Node default" },
    ...choices.map((id) => ({ value: id, label: name(id) })),
  ];
  return (
    <div className="flex w-full flex-col gap-2">
      <Label htmlFor={id}>Display provider</Label>
      <Select
        items={items}
        value={value ?? "node-default"}
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
