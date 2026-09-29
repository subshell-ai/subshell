import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  confirmAction,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { useStore } from "@tanstack/react-form";
import { useMemo } from "react";
import { type InstancePluginRow, useInstallInstancePlugin } from "@/hooks/use-instance-plugins";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { derivePluginId, isSafePluginId, parseNpmSpec } from "@/lib/plugin-spec";

/**
 * Install by name: the one field where the operator names a package this
 * build does not carry, so the one place the page asks (spec 2026-09-10 §6).
 * A name that resolves to a built-in catalog row is still one click — those
 * bytes are embedded and no confirmation was ever about them. Anything else
 * is third-party code running on the CONTROL PLANE now, and the copy says so:
 * not "on a node's OS user" (the superseded phase-4 wording), because the
 * reach moved with the install.
 *
 * Gated by the substrate sweep (spec 2026-09-29): the button stays ABSENT
 * while the name is empty (below), and once a name is typed it is DISABLED
 * until the id the install would use actually exists — the sentence under
 * the id box names the problem as it types. `resolveInstallTarget` is the
 * single resolution both the validator and the submit guard read, so the
 * gate and the action can disagree about nothing.
 */

const NO_USABLE_ID = "That package name gives no usable plugin id. Name the id the plugin declares.";

/** Where a typed spec lands: a built-in row by fast path, or third-party
 *  under an id that is derived, typed, or missing. */
function resolveInstallTarget(
  values: { spec: string; pluginId: string },
  builtInIds: Set<string>,
): { kind: "catalog"; id: string } | { kind: "third-party"; id: string | undefined } {
  const value = values.spec.trim();
  // "A name we did not ship" is the confirm's condition, and the test is
  // deliberately NARROWER than "the slug looks like a built-in": the fast
  // path is only a bare safe id, or an unpinned package under the
  // `@subshell-ai` scope (the scope the built-ins are actually published
  // under). Anything else — including `@acme/plugin-pi`, the naming a
  // third party would copy — goes through the confirm with the typed spec
  // FORWARDED, so the server's claim guard (`resolveBuiltInFromSpec` names
  // the built-in by exact id or its real package name; a spec whose
  // declared id conflicts is refused by name) is the resolution authority.
  // A spec-displacing fast path here would silently install THIS build's
  // copy while reporting the typed package's name.
  const { name, range } = parseNpmSpec(value);
  const derived = derivePluginId(value);
  const catalogId =
    isSafePluginId(value) && builtInIds.has(value)
      ? value
      : name.startsWith("@subshell-ai/") && range === undefined && derived !== undefined && builtInIds.has(derived)
        ? derived
        : undefined;
  if (catalogId !== undefined) return { kind: "catalog", id: catalogId };
  const id = values.pluginId.trim() !== "" ? values.pluginId.trim() : derived;
  return { kind: "third-party", id };
}

/** The gate's reason, if any. An EMPTY spec is not a problem to explain —
 *  the button is simply absent then (see the JSX note). */
function specProblems(values: { spec: string; pluginId: string }, builtInIds: Set<string>): FieldProblems {
  if (values.spec.trim() === "") return {};
  const target = resolveInstallTarget(values, builtInIds);
  if (target.kind === "catalog") return {};
  if (target.id === undefined || !isSafePluginId(target.id)) return { pluginId: NO_USABLE_ID };
  return {};
}

export function InstallByNameForm({ plugins }: { plugins: InstancePluginRow[] }) {
  const install = useInstallInstancePlugin();
  const builtInIds = useMemo(() => new Set(plugins.filter((p) => p.builtIn).map((p) => p.id)), [plugins]);

  const form = makeForm({
    defaultValues: { spec: "", pluginId: "" },
    validator: (values) => specProblems(values, builtInIds),
    onSubmit: async (values) => {
      const value = values.spec.trim();
      if (value === "") return;
      const target = resolveInstallTarget(values, builtInIds);
      if (target.kind === "catalog") {
        install.mutate({ pluginId: target.id }, { onSuccess: () => form.reset() });
        return;
      }
      if (target.id === undefined || !isSafePluginId(target.id)) return; // the gate already refuses
      const installId = target.id; // narrowed before the closure: the confirm's .then sees a string
      void confirmAction({
        title: `Install ${value}?`,
        description:
          "The package is fetched from the npm registry, and its code runs on the control plane: in the server's own process, with the reach that process has (the instance database and the key that signs commands for every enrolled node). This is the same trust decision as installing the agent CLI the plugin drives.",
        confirmLabel: "Install",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        install.mutate(
          { pluginId: installId, spec: value },
          {
            onSuccess: () => {
              form.reset();
            },
          },
        );
      });
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const disabled = useSubmitDisabled(form, install.isPending);

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="space-y-3"
        >
          <form.Field name="spec">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-spec">Install from npm</Label>
                <Input
                  id="plugin-spec"
                  placeholder="name, @scope/pkg, optionally @version"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>
          <form.Field name="pluginId">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-id">Plugin id</Label>
                <Input
                  id="plugin-id"
                  placeholder={derivePluginId(values.spec.trim()) ?? "usually read from the package name"}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <p className="text-detail text-muted-foreground">
                  Only if the package declares a different id than its name suggests. A mismatch is refused by name, and
                  the refusal says what to type here.
                </p>
                {fieldError(field.state.meta.errors) && (
                  <p role="alert" className="text-destructive text-detail">
                    {fieldError(field.state.meta.errors)}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          {install.isError && (
            <p className="text-destructive text-detail">
              {errMessage(install.error, "The install failed. Nothing changed.")}
            </p>
          )}
          {/* Absent, not disabled, while the name is empty: an empty field is
              nothing to install, and a dead button would only advertise the
              form as the page's main action. Once a name is typed the button
              is present, and the id sentence above explains a grey one. */}
          {values.spec.trim() !== "" && (
            <Button type="submit" disabled={disabled}>
              {install.isPending ? "Installing…" : "Install"}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
