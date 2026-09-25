---
"@internal/desktop-server": patch
---

Crash fix: on 1.0.1, pressing "Allow Photos" on the permissions screen ABORTED the app. The hop to the main thread used an Objective-C selector that does not exist (`+[NSThread performBlockOnMainThread:]`), and an unrecognized selector aborts the process. The request now reaches the main thread through Tauri's checked `run_on_main_thread` API, so no selector is guessed, and it is made on the main thread the way PhotoKit wants. That was the original fix's point: 1.0.0's press reached no sheet and registered nothing, and a press of the button is now the proof either way.
