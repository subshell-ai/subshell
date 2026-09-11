---
"@internal/desktop-server": patch
---

The Subshell Server console moved to TypeScript, Vite and Tailwind (its logic now builds into `ui/dist`; `tauri dev`/`tauri build` run the build as their own before-hooks). Behavior is unchanged except a fix the rebuild caught: after a failed action the console's "That did not work. See the output below." line is no longer erased by the action's own re-probe before it can appear.
