import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@internal/node-admin";
import { useState } from "react";
import {
  MAX_MOTION_SAMPLES_PER_SEC,
  MIN_MOTION_SAMPLES_PER_SEC,
  motionSamplesPerSec,
  setMotionSamplesPerSec,
} from "@/lib/mouse-sampling-pref";

/**
 * Per-DEVICE cap on how often a moving pointer reports into a terminal.
 *
 * It exists because the cost is not obvious from the behaviour: with mouse
 * reporting on — tmux enables it, and the agent TUIs do too — every pointer
 * movement becomes a WebSocket frame and then a `tmux send-keys`, which is a
 * process spawn serialized against the pane's real keystrokes. An unthrottled
 * hand drifting over the terminal can therefore make typing feel slow.
 *
 * Only MOVEMENT is sampled. Clicks, releases, wheel notches and keystrokes are
 * never delayed, and the last position in each window is the one sent, so a
 * drag still ends where the pointer stopped.
 */
export function MouseSamplingCard() {
  // Lazy read: the choice is browser-local, so there is no in-flight state to
  // wait for (the same shape as SwipeNavCard).
  const [rate, setRate] = useState(() => motionSamplesPerSec());
  // What is in the box while it is being edited — which may be empty or
  // out of range, and must not be clamped mid-keystroke.
  const [draft, setDraft] = useState(() => String(motionSamplesPerSec()));

  function commit() {
    const stored = setMotionSamplesPerSec(Number(draft));
    setRate(stored);
    setDraft(String(stored));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mouse movement reporting</CardTitle>
        <CardDescription>
          How many times a second pointer movement is sent into a terminal. Each report costs the pane a process on the
          server, so a lower number keeps typing responsive while the mouse is moving. Clicks, scrolling and keystrokes
          are never affected.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Label className="font-strong text-label" htmlFor="mouse-samples">
            Samples per second
          </Label>
          <Input
            id="mouse-samples"
            type="number"
            inputMode="numeric"
            min={MIN_MOTION_SAMPLES_PER_SEC}
            max={MAX_MOTION_SAMPLES_PER_SEC}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            // Enter commits too, or the box and the sentence under it disagree
            // for as long as the field keeps focus — which is exactly how long
            // someone who typed a number and pressed Enter will be looking at
            // them.
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className="w-24"
          />
        </div>
        <p className="mt-2 text-detail text-muted-foreground">
          {MIN_MOTION_SAMPLES_PER_SEC}–{MAX_MOTION_SAMPLES_PER_SEC}. Currently {rate} per second, about one every{" "}
          {Math.round(1000 / rate)} ms. Takes effect on the next terminal you open.
        </p>
      </CardContent>
    </Card>
  );
}
