// Windows would need this to avoid a console window; kept for parity even
// though the bundle targets are macOS and Linux only.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    subshell_desktop_client_lib::run()
}
