fn main() {
    println!("cargo:rerun-if-env-changed=SCREEN_PARTNER_DEV_UI");
    println!("cargo:rerun-if-env-changed=SCREEN_PARTNER_PORTABLE");
    tauri_build::build();
}
