import { ExplainedButton } from "@internal/node-admin";
import { type ButtonHTMLAttributes, useEffect, useRef, useState } from "react";

/** Preserve terminal focus and show feedback even for a quick touch tap. */
export function KeyBarControl({
  className,
  disabled,
  disabledReason,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { disabledReason?: string }) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Marks the pointerup that already ran the control, so the click that may
  // follow it (Chromium fires one; WebKit does not — see below) does not run
  // it a second time. Both gesture starts reset it, and the click path
  // resets it as it consumes it, so a synthetic click with no gesture behind
  // it (a bare `el.click()` right after a WebKit tap, which sends no click
  // to consume the mark) strands at most that one activation.
  const pointerActuated = useRef(false);
  // Marks the pointerdown that opened a press ON this control, so the
  // pointerup can tell its own release from one the browser delivers for a
  // gesture this control never saw start. A mouse has no implicit capture:
  // a drag off a neighbour releases HERE, and a right- or middle-button
  // release never produces a click anywhere — acting on either would send a
  // byte the user never pressed. (One nuance on the mouse: a press that
  // leaves this button and returns loses its arm to pointerleave, so that
  // release actuates through the click path instead. The synthesized click
  // fires there on both engines — measured on Chromium and desktop WebKit —
  // so the press still lands exactly once.)
  const pressOpened = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  function press() {
    if (disabled) return;
    clearTimeout(timer.current);
    setPressed(true);
  }
  function release() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPressed(false), 160);
  }
  function cancel() {
    clearTimeout(timer.current);
    pressOpened.current = false;
    setPressed(false);
  }
  return (
    <ExplainedButton
      {...props}
      disabled={disabled}
      disabledReason={disabledReason}
      className={className}
      data-pressed={!disabled && pressed}
      onPointerDown={(event) => {
        event.preventDefault();
        pointerActuated.current = false;
        // Only a primary button-0 press arms the control. A right/middle
        // press or a secondary finger must not leave it actuated, so the
        // matching release (which never produces a click) finds nothing to
        // run — and a release that arrives for a gesture this control never
        // saw start (a mouse dragged in from a neighbour) is likewise inert.
        if (event.button === 0 && event.isPrimary) pressOpened.current = true;
        press();
      }}
      onPointerUp={(event) => {
        const startedHere = pressOpened.current;
        // Only a release that COULD actuate consumes the arm. A second
        // finger's pointerup is delivered here too under implicit capture;
        // clearing the arm on it would strand the primary press that lifts
        // afterward, so the release that can't run must leave the arm set.
        const primaryRelease = event.button === 0 && event.isPrimary;
        if (primaryRelease) pressOpened.current = false;
        release();
        if (disabled || !startedHere || !primaryRelease) return;
        // The row scrolls horizontally under a swipe, and a touch pointer's
        // implicit capture delivers the pointerup HERE even when the finger
        // has panned past the button's edge. Acting on that pointerup
        // unchecked would send a byte into the live pane for what was only a
        // pan to reach the far end of the bar.
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        ) {
          cancel();
          return;
        }
        // Activate on the pointerup itself: the focus-pinning preventDefault
        // below makes WebKit (iOS Safari / WKWebView) skip the synthesized
        // click entirely, so a control that waited for `click` never fired
        // under a real finger there. Chromium still clicks — hence the dedupe.
        pointerActuated.current = true;
        onClick?.(event);
      }}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onBlur={cancel}
      onKeyDown={(event) => {
        pointerActuated.current = false;
        if (event.key === " " || event.key === "Enter") press();
      }}
      onKeyUp={release}
      onClick={(event) => {
        if (pointerActuated.current) {
          // The click that follows the pointerup on click-synthesizing
          // browsers: the action already ran, don't run it again.
          pointerActuated.current = false;
          return;
        }
        if (disabled) return;
        // Keyboard Enter/Space reach the action through the click and never
        // touch a pointer.
        press();
        release();
        onClick?.(event);
      }}
    />
  );
}
