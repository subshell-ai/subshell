#[path = "../../../../native/display-helper/build_support.rs"]
mod display_helper_build;

fn main() {
    display_helper_build::build();
    tauri_build::build()
}
