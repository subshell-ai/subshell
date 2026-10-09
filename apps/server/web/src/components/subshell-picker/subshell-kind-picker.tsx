import { Check } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";

export type SubshellKind = "agent" | "ssh";

/** Every new-subshell entry point offers the same two launch paths. */
export function SubshellKindPicker({
  value,
  onChange,
  disabled,
}: {
  disabled?: boolean;
  value: SubshellKind;
  onChange: (value: SubshellKind) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <Segmented
        ariaLabel="Subshell type"
        selectedVariant="default"
        value={value}
        onChange={onChange}
        options={[
          {
            value: "agent",
            label: "Agent or terminal",
            icon: value === "agent" ? <Check aria-hidden="true" /> : undefined,
          },
          { value: "ssh", label: "SSH terminal", icon: value === "ssh" ? <Check aria-hidden="true" /> : undefined },
        ]}
      />
    </fieldset>
  );
}
