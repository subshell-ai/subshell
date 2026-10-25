import { Label, type NodeDetail } from "@internal/node-admin";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER, VIRTUAL_DISPLAY_PROVIDERS } from "@internal/subshell-protocol";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NodeViewReadiness } from "./node-view-readiness";
export function NodeDisplayProviders({
  node,
  disabledReason,
  onChange,
}: {
  node: NodeDetail;
  disabledReason?: string;
  onChange: (providers: string[], provider?: string) => void;
}) {
  const enabled = node.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER];
  const current = node.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER;
  const choices = VIRTUAL_DISPLAY_PROVIDERS.filter((p) => enabled.includes(p.id));
  return (
    <div className="flex w-full flex-col gap-4">
      {VIRTUAL_DISPLAY_PROVIDERS.map((p) => {
        const id = `node-display-provider-${p.id}`;
        const control = (
          <Checkbox
            id={id}
            checked={enabled.includes(p.id)}
            disabled={Boolean(disabledReason)}
            onCheckedChange={(on) => {
              const next = on ? [...enabled, p.id] : enabled.filter((id) => id !== p.id);
              onChange(next, next.includes(current) ? current : next[0]);
            }}
          />
        );
        return (
          <div key={p.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              {disabledReason ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      // biome-ignore lint/a11y/useSemanticElements: a button cannot wrap a checkbox; this focus target explains why it is disabled.
                      <span
                        role="button"
                        tabIndex={0}
                        aria-disabled={true}
                        aria-label={disabledReason}
                        className="inline-flex"
                      />
                    }
                  >
                    {control}
                  </TooltipTrigger>
                  <TooltipContent>{disabledReason}</TooltipContent>
                </Tooltip>
              ) : (
                control
              )}
              <Label htmlFor={id}>Allow {p.name}</Label>
            </div>
            <p className="text-detail text-muted-foreground">{p.description}</p>
            <NodeViewReadiness node={node} provider={p.id} inspect />
            {!enabled.includes(p.id) && (
              <p className="text-detail text-warning">This provider is disabled for new virtual displays.</p>
            )}
          </div>
        );
      })}
      {choices.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="node-default-display-provider">Default display provider</Label>
          <Select
            items={choices.map((p) => ({ value: p.id, label: p.name }))}
            value={current}
            disabled={Boolean(disabledReason)}
            onValueChange={(p) => {
              if (p && p !== current) onChange(enabled, p);
            }}
          >
            <SelectTrigger id="node-default-display-provider" disabledReason={disabledReason}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-detail text-warning">Enable a provider before starting a subshell with a virtual display.</p>
      )}
      <p className="text-detail text-muted-foreground">
        New subshells use the default unless you choose another enabled provider. Existing subshells keep their saved
        provider when restarted.
      </p>
    </div>
  );
}
