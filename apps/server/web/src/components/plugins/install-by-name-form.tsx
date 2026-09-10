import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type InstancePluginRow, useInstallInstancePlugin } from "@/hooks/use-instance-plugins";
import { errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import { derivePluginId, isSafePluginId, parseNpmSpec } from "@/lib/plugin-spec";

/**
 * Install by name: the one field where the operator names a package this
 * build does not carry, so the one place the page asks (spec 2026-09-10 §6).
 * A name that resolves to a built-in catalog row is still one click — those
 * bytes are embedded and no confirmation was ever about them. Anything else
 * is third-party code running on the CONTROL PLANE now, and the copy says so:
 * not "on a node's OS user" (the superseded phase-4 wording), because the
 * reach moved with the install.
 */
export function InstallByNameForm({ plugins }: { plugins: InstancePluginRow[] }) {
  const [spec, setSpec] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const install = useInstallInstancePlugin();

  const builtInIds = new Set(plugins.filter((p) => p.builtIn).map((p) => p.id));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);
    const value = spec.trim();
    if (value === "") return;

    // "A name we did not ship" is the confirm's whole condition, so the
    // catalog test is the same one the list rows carry, by id either way
    // (`pi` or `@subshell-ai/plugin-pi`), and only for an UNPINNED spec: the
    // page cannot know this build's embedded version, so a pin is the
    // registry's question, not this build's.
    const { range } = parseNpmSpec(value);
    const derived = derivePluginId(value);
    const catalogId = builtInIds.has(value)
      ? value
      : range === undefined && derived !== undefined && builtInIds.has(derived)
        ? derived
        : undefined;
    if (catalogId !== undefined) {
      install.mutate(
        { pluginId: catalogId },
        {
          onSuccess: () => {
            setSpec("");
            setPluginId("");
          },
        },
      );
      return;
    }

    const id = pluginId.trim() !== "" ? pluginId.trim() : derived;
    if (id === undefined || !isSafePluginId(id)) {
      setFieldError("That package name gives no usable plugin id. Name the id the plugin declares.");
      return;
    }
    void confirmAction({
      title: `Install ${value}?`,
      description:
        "The package is fetched from the npm registry, and its code runs on the control plane: in the server's own process, with the reach that process has (the instance database and the key that signs commands for every enrolled node). This is the same trust decision as installing the agent CLI the plugin drives.",
      confirmLabel: "Install",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      install.mutate(
        { pluginId: id, spec: value },
        {
          onSuccess: () => {
            setSpec("");
            setPluginId("");
          },
        },
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Install from npm</CardTitle>
        <CardDescription>
          A package this build does not carry, fetched from the registry the server is configured for and installed into
          the instance store.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plugin-spec">Install from npm</Label>
            <Input
              id="plugin-spec"
              placeholder="name, @scope/pkg, optionally @version"
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plugin-id">Plugin id</Label>
            <Input
              id="plugin-id"
              placeholder={derivePluginId(spec.trim()) ?? "usually read from the package name"}
              value={pluginId}
              onChange={(e) => setPluginId(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Only if the package declares a different id than its name suggests. A mismatch is refused by name, and the
              refusal says what to type here.
            </p>
          </div>
          {fieldError && <p className="text-destructive text-sm">{fieldError}</p>}
          {install.isError && (
            <p className="text-destructive text-sm">
              {errMessage(install.error, "The install failed. Nothing changed.")}
            </p>
          )}
          {/* Absent, not disabled, while the name is empty: an empty field is
              nothing to install, and a dead button would only advertise the
              form as the page's main action. */}
          {spec.trim() !== "" && (
            <Button type="submit" disabled={install.isPending}>
              {install.isPending ? "Installing…" : "Install"}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
