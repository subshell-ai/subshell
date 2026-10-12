import { Alert, Pressable, type PressableProps } from "react-native";

/** A touch device explains an unavailable action on tap, without running it. */
export function ExplainedPressable({
  disabled,
  disabledReason,
  onPress,
  onPressIn,
  onLongPress,
  accessibilityState,
  ...props
}: PressableProps & { disabledReason: string }) {
  return (
    <Pressable
      {...props}
      accessibilityState={{ ...accessibilityState, disabled: Boolean(disabled) }}
      accessibilityHint={disabled ? disabledReason : props.accessibilityHint}
      onPress={disabled ? () => Alert.alert("Action unavailable", disabledReason) : onPress}
      onPressIn={disabled ? undefined : onPressIn}
      onLongPress={disabled ? undefined : onLongPress}
    />
  );
}
