// Keeps a console window from opening beside the app in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    icmm_desktop::run();
}
