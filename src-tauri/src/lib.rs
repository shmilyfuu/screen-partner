mod diagnostics;
mod gpu;
#[cfg(target_os = "macos")]
mod macos_window;
mod telemetry;

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalSize, Manager, PhysicalPosition, Position, RunEvent, Size, State,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const SETTINGS_SCHEMA_VERSION: u32 = 2;
const DEFAULT_MARGIN_RIGHT: f64 = 48.0;
const DEFAULT_MARGIN_BOTTOM: f64 = 72.0;
const BASE_WINDOW_WIDTH: f64 = 240.0;
const BASE_WINDOW_HEIGHT: f64 = 260.0;
const PET_SCALE_OPTIONS: [f64; 4] = [0.75, 1.0, 1.25, 1.5];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowSettings {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    pet_scale: f64,
    always_on_top: bool,
    random_behavior_enabled: bool,
    system_awareness_enabled: bool,
    launch_at_startup: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            pet_scale: 1.0,
            always_on_top: true,
            random_behavior_enabled: true,
            system_awareness_enabled: true,
            launch_at_startup: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    schema_version: u32,
    #[serde(default)]
    window: Option<WindowSettings>,
    #[serde(default)]
    desktop: DesktopSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            window: None,
            desktop: DesktopSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct DragSession {
    pointer_x: f64,
    pointer_y: f64,
    window_x: i32,
    window_y: i32,
    scale_factor: f64,
}

#[derive(Default)]
struct DragState(Mutex<Option<DragSession>>);

#[tauri::command]
fn development_ui_enabled() -> bool {
    cfg!(debug_assertions) || option_env!("SCREEN_PARTNER_DEV_UI") == Some("1")
}

#[tauri::command]
fn begin_window_drag(
    app: tauri::AppHandle,
    drag_state: State<'_, DragState>,
    screen_x: f64,
    screen_y: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| format!("failed to read window position: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("failed to read window scale factor: {error}"))?;

    let mut state = drag_state
        .0
        .lock()
        .map_err(|_| "window drag state is unavailable".to_string())?;
    *state = Some(DragSession {
        pointer_x: screen_x,
        pointer_y: screen_y,
        window_x: position.x,
        window_y: position.y,
        scale_factor,
    });

    Ok(())
}

#[tauri::command]
fn update_window_drag(
    app: tauri::AppHandle,
    drag_state: State<'_, DragState>,
    screen_x: f64,
    screen_y: f64,
) -> Result<(), String> {
    let session = {
        let state = drag_state
            .0
            .lock()
            .map_err(|_| "window drag state is unavailable".to_string())?;
        *state
    };
    let Some(session) = session else {
        return Ok(());
    };

    let delta_x = ((screen_x - session.pointer_x) * session.scale_factor).round();
    let delta_y = ((screen_y - session.pointer_y) * session.scale_factor).round();
    if !delta_x.is_finite() || !delta_y.is_finite() {
        return Err("window drag coordinates are invalid".to_string());
    }

    let target_x = session.window_x.saturating_add(delta_x as i32);
    let target_y = session.window_y.saturating_add(delta_y as i32);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            target_x, target_y,
        )))
        .map_err(|error| format!("failed to move window: {error}"))
}

#[tauri::command]
fn end_window_drag(drag_state: State<'_, DragState>) -> Result<(), String> {
    let mut state = drag_state
        .0
        .lock()
        .map_err(|_| "window drag state is unavailable".to_string())?;
    *state = None;
    Ok(())
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(windows)]
    if option_env!("SCREEN_PARTNER_PORTABLE") == Some("1") {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir.join("data").join("settings.json");
            }
        }
    }

    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

fn valid_pet_scale(value: f64) -> bool {
    PET_SCALE_OPTIONS
        .iter()
        .any(|candidate| (value - candidate).abs() < f64::EPSILON)
}

fn parse_settings(text: &str) -> Option<Settings> {
    let mut settings: Settings = serde_json::from_str(text).ok()?;
    if settings.schema_version == 0 || settings.schema_version > SETTINGS_SCHEMA_VERSION {
        return None;
    }

    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    if !valid_pet_scale(settings.desktop.pet_scale) {
        settings.desktop.pet_scale = DesktopSettings::default().pet_scale;
    }
    Some(settings)
}

fn load_settings(app: &tauri::AppHandle) -> Settings {
    fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|text| parse_settings(&text))
        .unwrap_or_default()
}

fn write_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app);
    let parent = path
        .parent()
        .ok_or_else(|| "settings directory is unavailable".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create settings directory: {error}"))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("failed to serialize settings: {error}"))?;
    fs::write(&path, format!("{json}\n"))
        .map_err(|error| format!("failed to write settings: {error}"))
}

fn settings_with_runtime_state(app: &tauri::AppHandle) -> Settings {
    let mut settings = load_settings(app);
    if let Ok(enabled) = app.autolaunch().is_enabled() {
        settings.desktop.launch_at_startup = enabled;
    }
    settings
}

fn load_window_position(app: &tauri::AppHandle) -> Option<WindowSettings> {
    load_settings(app).window
}

fn save_current_main_window_position(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    let mut settings = load_settings(app);
    settings.window = Some(WindowSettings {
        x: position.x,
        y: position.y,
    });
    let _ = write_settings(app, &settings);
}

fn saved_position_is_visible(window: &tauri::WebviewWindow, position: WindowSettings) -> bool {
    let Ok(window_size) = window.outer_size() else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };

    let center_x = position.x as i64 + window_size.width as i64 / 2;
    let center_y = position.y as i64 + window_size.height as i64 / 2;

    monitors.iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let left = monitor_position.x as i64;
        let top = monitor_position.y as i64;
        let right = left + monitor_size.width as i64;
        let bottom = top + monitor_size.height as i64;

        center_x >= left && center_x < right && center_y >= top && center_y < bottom
    })
}

fn default_main_screen_position(window: &tauri::WebviewWindow) -> Option<PhysicalPosition<i32>> {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.available_monitors().ok()?.into_iter().next())?;
    let window_size = window.outer_size().ok()?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let margin_right = (DEFAULT_MARGIN_RIGHT * scale_factor).round() as i32;
    let margin_bottom = (DEFAULT_MARGIN_BOTTOM * scale_factor).round() as i32;

    let x =
        (monitor_position.x + monitor_size.width as i32 - window_size.width as i32 - margin_right)
            .max(monitor_position.x);
    let y = (monitor_position.y + monitor_size.height as i32
        - window_size.height as i32
        - margin_bottom)
        .max(monitor_position.y);

    Some(PhysicalPosition::new(x, y))
}

fn resize_main_window(
    window: &tauri::WebviewWindow,
    pet_scale: f64,
    preserve_bottom_center: bool,
) -> Result<(), String> {
    let old_position = preserve_bottom_center.then(|| window.outer_position().ok()).flatten();
    let old_size = preserve_bottom_center.then(|| window.outer_size().ok()).flatten();
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("failed to read window scale factor: {error}"))?;

    window
        .set_size(Size::Logical(LogicalSize::new(
            BASE_WINDOW_WIDTH * pet_scale,
            BASE_WINDOW_HEIGHT * pet_scale,
        )))
        .map_err(|error| format!("failed to resize main window: {error}"))?;

    if let (Some(position), Some(size)) = (old_position, old_size) {
        let target_width = (BASE_WINDOW_WIDTH * pet_scale * scale_factor).round() as i64;
        let target_height = (BASE_WINDOW_HEIGHT * pet_scale * scale_factor).round() as i64;
        let anchor_x = position.x as i64 + size.width as i64 / 2;
        let anchor_y = position.y as i64 + size.height as i64;
        let target_x = (anchor_x - target_width / 2).clamp(i32::MIN as i64, i32::MAX as i64);
        let target_y = (anchor_y - target_height).clamp(i32::MIN as i64, i32::MAX as i64);
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                target_x as i32,
                target_y as i32,
            )))
            .map_err(|error| format!("failed to preserve pet position after resize: {error}"))?;
    }

    Ok(())
}

fn apply_main_window_desktop_settings(
    app: &tauri::AppHandle,
    previous: Option<&DesktopSettings>,
    desktop: &DesktopSettings,
    preserve_bottom_center: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window
        .set_always_on_top(desktop.always_on_top)
        .map_err(|error| format!("failed to update always-on-top: {error}"))?;

    let scale_changed = previous
        .map(|value| value.pet_scale != desktop.pet_scale)
        .unwrap_or(true);
    if scale_changed {
        resize_main_window(&window, desktop.pet_scale, preserve_bottom_center)?;
    }

    Ok(())
}

fn restore_or_place_main_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    if let Some(saved) = load_window_position(app) {
        if saved_position_is_visible(window, saved) {
            let _ =
                window.set_position(Position::Physical(PhysicalPosition::new(saved.x, saved.y)));
            return;
        }
    }

    if let Some(position) = default_main_screen_position(window) {
        let _ = window.set_position(Position::Physical(position));
    }
}

fn update_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| format!("failed to update launch-at-startup: {error}"))
}

fn update_desktop_settings_internal(
    app: &tauri::AppHandle,
    desktop: DesktopSettings,
) -> Result<Settings, String> {
    if !valid_pet_scale(desktop.pet_scale) {
        return Err("petScale must be one of 0.75, 1, 1.25, or 1.5".to_string());
    }

    let previous = load_settings(app);
    update_autostart(app, desktop.launch_at_startup)?;
    apply_main_window_desktop_settings(app, Some(&previous.desktop), &desktop, true)?;

    let mut settings = previous;
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    settings.desktop = desktop;
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(position) = window.outer_position() {
            settings.window = Some(WindowSettings {
                x: position.x,
                y: position.y,
            });
        }
    }

    write_settings(app, &settings)?;
    app.emit("settings-changed", settings.clone())
        .map_err(|error| format!("failed to broadcast settings: {error}"))?;
    Ok(settings)
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Settings {
    settings_with_runtime_state(&app)
}

#[tauri::command]
fn update_desktop_settings(
    app: tauri::AppHandle,
    desktop: DesktopSettings,
) -> Result<Settings, String> {
    update_desktop_settings_internal(&app, desktop)
}

#[tauri::command]
fn reset_desktop_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    update_desktop_settings_internal(&app, DesktopSettings::default())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn recall_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(position) = default_main_screen_position(&window) {
            let _ = window.set_position(Position::Physical(position));
            save_current_main_window_position(app);
        }
        let _ = window.unminimize();
        let _ = window.show();
    }
}

#[tauri::command]
fn show_pet(app: tauri::AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn hide_pet(app: tauri::AppHandle) {
    hide_main_window(&app);
}

#[tauri::command]
fn recall_pet(app: tauri::AppHandle) {
    recall_main_window(&app);
}

fn show_settings_window_internal(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .show()
            .map_err(|error| format!("failed to show settings window: {error}"))?;
        let _ = window.set_focus();
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Screen Partner 设置")
    .inner_size(500.0, 560.0)
    .resizable(false)
    .center()
    .build()
    .map_err(|error| format!("failed to create settings window: {error}"))?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
async fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    show_settings_window_internal(&app)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(DragState::default())
        .invoke_handler(tauri::generate_handler![
            development_ui_enabled,
            diagnostics::start_diagnostic_log,
            diagnostics::append_diagnostic_log,
            begin_window_drag,
            update_window_drag,
            end_window_drag,
            get_settings,
            update_desktop_settings,
            reset_desktop_settings,
            show_pet,
            hide_pet,
            recall_pet,
            show_settings_window
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                macos_window::allow_unconstrained_top_edge(&window)
                    .map_err(std::io::Error::other)?;

                let settings = load_settings(app.handle());
                apply_main_window_desktop_settings(
                    app.handle(),
                    None,
                    &settings.desktop,
                    false,
                )
                .map_err(std::io::Error::other)?;
                restore_or_place_main_window(app.handle(), &window);
                let _ = window.show();
            }

            telemetry::start_telemetry(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏宠物", true, None::<&str>)?;
            let recall = MenuItem::with_id(app, "recall", "召回到主屏幕", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Screen Partner", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &recall, &settings, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Screen Partner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "recall" => recall_main_window(app),
                    "settings" => {
                        let handle = app.clone();
                        let _ = std::thread::spawn(move || {
                            if let Err(error) = show_settings_window_internal(&handle) {
                                eprintln!("[screen-partner] {error}");
                            }
                        });
                    }
                    "quit" => {
                        save_current_main_window_position(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Screen Partner");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            save_current_main_window_position(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_one_settings_migrate_without_losing_window_position() {
        let settings = parse_settings(
            r#"{
              "schemaVersion": 1,
              "window": {"x": 120, "y": -30}
            }"#,
        )
        .expect("schema 1 settings should migrate");

        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(settings.window, Some(WindowSettings { x: 120, y: -30 }));
        assert_eq!(settings.desktop, DesktopSettings::default());
    }

    #[test]
    fn unsupported_pet_scale_falls_back_to_default_scale() {
        let settings = parse_settings(
            r#"{
              "schemaVersion": 2,
              "window": null,
              "desktop": {
                "petScale": 3.0,
                "alwaysOnTop": false,
                "randomBehaviorEnabled": false,
                "systemAwarenessEnabled": false,
                "launchAtStartup": true
              }
            }"#,
        )
        .expect("settings should remain readable");

        assert_eq!(settings.desktop.pet_scale, 1.0);
        assert!(!settings.desktop.always_on_top);
        assert!(!settings.desktop.random_behavior_enabled);
        assert!(!settings.desktop.system_awareness_enabled);
        assert!(settings.desktop.launch_at_startup);
    }
}
