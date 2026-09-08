import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";

/**
 * The Face ID gate (spec §Security notes): gates USE of the token — attaching
 * a socket, firing an action — not its storage. This credential can inject
 * keystrokes into every pane on the instance, so an unlocked phone lying
 * around is the threat the model takes seriously.
 *
 * Degradation rules, deliberate:
 * - device without biometric hardware/enrollment → allowed (do not lock out
 *   a phone that cannot do Face ID; the Keychain itself stays protected);
 * - user disabled it in Settings → allowed (the flag is per-device).
 */
const KEY = "subshell.biometric.enabled";

/** @returns Whether the gate is switched on (default: on) */
export async function biometricEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY)) !== "0";
}

/** @param on - Persist the Settings toggle */
export async function setBiometricEnabled(on: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY, on ? "1" : "0");
}

/**
 * Prompt if (and only if) the gate applies.
 * @param reason - shown in the system prompt ("Unlock the terminal")
 * @returns true when the caller may proceed
 */
export async function requireBiometric(reason?: string): Promise<boolean> {
  if (!(await biometricEnabled())) return true;
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  if (!hasHardware || !enrolled) return true;
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: reason ?? "subshell",
    disableDeviceFallback: false,
  });
  return res.success;
}
