use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn recall_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.center();
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let recall = MenuItem::with_id(app, "recall", "显示/召回宠物", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Screen Partner", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&recall, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Screen Partner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "recall" => recall_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        recall_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Screen Partner");
}
