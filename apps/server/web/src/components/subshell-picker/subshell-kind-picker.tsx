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
        value={value}
        onChange={onChange}
        options={[
          {
            value: "agent",
            label: "Agent or terminal",
          },
          { value: "ssh", label: "SSH terminal" },
        ]}
      />
    </fieldset>
  );
}
