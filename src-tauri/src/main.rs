// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(mode) = plisto_lib::helper_mode() {
        std::process::exit(plisto_lib::run_helper_mode(mode));
    }
    plisto_lib::run()
}
