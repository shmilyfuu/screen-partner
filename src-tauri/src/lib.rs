mod gpu;
#[cfg(target_os = "macos")]
mod macos_window;
mod telemetry;

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, Position, RunEvent, State,
};

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MARGIN_RIGHT: f64 = 48.0;
const DEFAULT_MARGIN_BOTTOM: f64 = 72.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowSettings {
    x: i32,
    y: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    schema_version: u32,
    window: WindowSettings,
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
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.join("data").join("settings.json");
        }
    }

    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

fn load_window_position(app: &tauri::AppHandle) -> Option<WindowSettings> {
    let text = fs::read_to_string(settings_path(app)).ok()?;
    let settings: Settings = serde_json::from_str(&text).ok()?;
    (settings.schema_version == SETTINGS_SCHEMA_VERSION).then_some(settings.window)
}

fn save_window_position(app: &tauri::AppHandle, position: WindowSettings) {
    let path = settings_path(app);
    let Some(parent) = path.parent() else {
        return;
    };

    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let settings = Settings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        window: position,
    };

    let Ok(json) = serde_json::to_string_pretty(&settings) else {
        return;
    };

    let _ = fs::write(path, format!("{json}\n"));
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

fn save_current_main_window_position(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    save_window_position(
        app,
        WindowSettings {
            x: position.x,
            y: position.y,
        },
    );
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
        }
        let _ = window.unminimize();
        let _ = window.show();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(DragState::default())
        .invoke_handler(tauri::generate_handler![
            development_ui_enabled,
            begin_window_drag,
            update_window_drag,
            end_window_drag
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                macos_window::allow_unconstrained_top_edge(&window)
                    .map_err(std::io::Error::other)?;

                restore_or_place_main_window(app.handle(), &window);
                let _ = window.show();
            }

            telemetry::start_telemetry(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏宠物", true, None::<&str>)?;
            let recall = MenuItem::with_id(app, "recall", "召回到主屏幕", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Screen Partner", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &recall, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Screen Partner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "recall" => recall_main_window(app),
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
