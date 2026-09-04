use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use tauri::Manager;

const DIAGNOSTIC_LOG_FILE: &str = "phase4-diagnostic.log";

fn diagnostic_logging_enabled() -> bool {
    cfg!(debug_assertions) || option_env!("SCREEN_PARTNER_DEV_UI") == Some("1")
}

fn diagnostic_log_path(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(windows)]
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.join("data").join(DIAGNOSTIC_LOG_FILE);
        }
    }

    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(DIAGNOSTIC_LOG_FILE)
}

fn ensure_parent(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "diagnostic log path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create diagnostic log directory: {error}"))
}

#[tauri::command]
pub fn start_diagnostic_log(app: tauri::AppHandle) -> Result<String, String> {
    if !diagnostic_logging_enabled() {
        return Err("diagnostic logging is disabled in this build".to_string());
    }

    let path = diagnostic_log_path(&app);
    ensure_parent(&path)?;
    fs::write(&path, b"").map_err(|error| format!("failed to reset diagnostic log: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn append_diagnostic_log(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    if !diagnostic_logging_enabled() || lines.is_empty() {
        return Ok(());
    }

    let path = diagnostic_log_path(&app);
    ensure_parent(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open diagnostic log: {error}"))?;

    for line in lines {
        let normalized = line.replace(['\r', '\n'], " ");
        writeln!(file, "{normalized}")
            .map_err(|error| format!("failed to append diagnostic log: {error}"))?;
    }

    file.flush()
        .map_err(|error| format!("failed to flush diagnostic log: {error}"))
}
