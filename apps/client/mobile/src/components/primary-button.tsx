import { ActivityIndicator, Pressable, Text } from "react-native";
import { colors, font, radius, touchTarget } from "@/lib/tokens";

/**
 * The shared primary CTA (review #9: four copy-pasted Pressable blocks with
 * the disabled condition computed twice — once for `disabled`, once for the
 * opacity). 44-tall blue pill, spinner while busy, dimmed while disabled.
 */
export function PrimaryButton({
  onPress,
  label,
  disabled = false,
  busy = false,
}: {
  onPress: () => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={{
        minHeight: touchTarget,
        borderRadius: radius,
        backgroundColor: colors.primary,
        alignItems: "center",
        justifyContent: "center",
        opacity: off ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color={colors.primaryFg} />
      ) : (
        // A button label is never regular (wave precedent: ui/button.tsx is
        // font-strong at the base; spec § 3.1 puts buttons inside `label`).
        // The role shape also fixes the latent gap: this Text used to ride
        // RN's platform-dependent default size.
        <Text style={{ color: colors.primaryFg, ...font("label") }}>{label}</Text>
      )}
    </Pressable>
  );
}
