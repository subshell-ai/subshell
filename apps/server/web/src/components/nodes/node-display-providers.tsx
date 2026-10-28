import { Label, type NodeDetail } from "@internal/node-admin";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER } from "@internal/subshell-protocol";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { bundledProvidersForMachine } from "@/lib/display-provider-choice";
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
  // The same "can this machine run it" reading the launch form and the preset
  // editor apply, so the settings page and the launch cannot disagree about
  // which providers exist here. An OS the node has not reported yet is no
  // verdict: filtering on it would tell the owner no provider supports an
  // operating system this machine never named, and strand the only place a
  // provider can be pre-enabled.
  const providers = bundledProvidersForMachine(node.os);
  const choices = providers.filter((p) => enabled.includes(p.id));
  return (
    <div className="flex w-full flex-col gap-4">
      {providers.map((p) => {
        const id = `node-display-provider-${p.id}`;
        const control = (
          <Checkbox
            id={id}
            checked={enabled.includes(p.id)}
            disabled={Boolean(disabledReason)}
            onCheckedChange={(on) => {
              const next = on ? [...enabled, p.id] : enabled.filter((id) => id !== p.id);
              const supported = next.filter((id) => providers.some((p) => p.id === id));
              onChange(next, supported.includes(current) ? current : supported[0]);
            }}
          />
        );
        return (
          <fieldset
            key={p.id}
            aria-label={`${p.name} display provider`}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          >
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
            {p.id === "betterdisplay" && (
              <p className="text-detail text-warning">
                On this node's Mac (macOS 14 or later), open Subshell Client or Subshell Server, choose Virtual Displays
                in the assistant window's sidebar, then Open Display Helper settings to enable the helper and grant
                macOS permissions. You can disable it from that panel at any time. This node setting cannot activate it.
                macOS displays share keyboard focus and the pointer.{" "}
                <a
                  href="https://docs.subshell.sh/previews/macos"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Setup instructions
                </a>
              </p>
            )}
            <NodeViewReadiness node={node} provider={p.id} inspect />
            {!enabled.includes(p.id) && (
              <p className="text-detail text-warning">This provider is disabled for new virtual displays.</p>
            )}
          </fieldset>
        );
      })}
      {choices.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="node-default-display-provider">Default display provider</Label>
          <Select
            items={choices.map((p) => ({ value: p.id, label: p.name }))}
            value={choices.some((p) => p.id === current) ? current : null}
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
        <p className="text-detail text-warning">
          {providers.length
            ? "Enable a provider before starting a subshell with a virtual display."
            : "No bundled virtual display provider supports this node's operating system."}
        </p>
      )}
      <p className="text-detail text-muted-foreground">
        New subshells use the default unless you choose another enabled provider. Existing subshells keep their saved
        provider when restarted.
      </p>
    </div>
  );
}
