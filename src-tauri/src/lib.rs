#[cfg(windows)]
use tauri::Manager;

#[cfg(windows)]
fn start_topmost_reassertion(window: tauri::WebviewWindow) -> tauri::Result<()> {
    use std::time::Duration;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let hwnd = window.hwnd()?;
    let raw_hwnd = hwnd.0 as isize;

    std::thread::spawn(move || {
        let hwnd = HWND(raw_hwnd as *mut std::ffi::c_void);

        loop {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }

            std::thread::sleep(Duration::from_millis(1000));
        }
    });

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(windows)]
            if let Some(window) = _app.get_webview_window("main") {
                start_topmost_reassertion(window)?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Screen Partner");
}
