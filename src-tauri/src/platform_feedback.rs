use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorFeedbackSample {
    pub kind: String,
    pub raw: Option<String>,
}

impl CursorFeedbackSample {
    fn new(kind: &str, raw: Option<String>) -> Self {
        Self {
            kind: kind.to_string(),
            raw,
        }
    }
}

pub fn sample_cursor_feedback() -> CursorFeedbackSample {
    platform::sample_cursor_feedback()
}

#[cfg(windows)]
mod platform {
    use super::CursorFeedbackSample;
    use std::{ffi::c_void, mem};

    const CURSOR_SHOWING: u32 = 0x0000_0001;
    const IDC_ARROW: usize = 32_512;
    const IDC_WAIT: usize = 32_514;
    const IDC_APPSTARTING: usize = 32_650;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct CursorInfo {
        size: u32,
        flags: u32,
        cursor: *mut c_void,
        screen_position: Point,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorInfo(cursor_info: *mut CursorInfo) -> i32;
        fn LoadCursorW(instance: *mut c_void, cursor_name: *const u16) -> *mut c_void;
    }

    pub fn sample_cursor_feedback() -> CursorFeedbackSample {
        let mut cursor_info = CursorInfo {
            size: mem::size_of::<CursorInfo>() as u32,
            flags: 0,
            cursor: std::ptr::null_mut(),
            screen_position: Point { x: 0, y: 0 },
        };

        if unsafe { GetCursorInfo(&mut cursor_info) } == 0
            || cursor_info.flags & CURSOR_SHOWING == 0
            || cursor_info.cursor.is_null()
        {
            return CursorFeedbackSample::new("unavailable", None);
        }

        let wait = unsafe { LoadCursorW(std::ptr::null_mut(), IDC_WAIT as *const u16) };
        if cursor_info.cursor == wait {
            return CursorFeedbackSample::new("busy", Some("IDC_WAIT".to_string()));
        }

        let app_starting =
            unsafe { LoadCursorW(std::ptr::null_mut(), IDC_APPSTARTING as *const u16) };
        if cursor_info.cursor == app_starting {
            return CursorFeedbackSample::new(
                "background_working",
                Some("IDC_APPSTARTING".to_string()),
            );
        }

        let arrow = unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW as *const u16) };
        if cursor_info.cursor == arrow {
            return CursorFeedbackSample::new("normal", Some("IDC_ARROW".to_string()));
        }

        CursorFeedbackSample::new("other", Some(format!("HCURSOR:{:p}", cursor_info.cursor)))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::CursorFeedbackSample;
    use std::{ffi::c_void, mem, os::raw::c_char};

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        #[link_name = "objc_msgSend"]
        fn objc_msg_send();
    }

    pub fn sample_cursor_feedback() -> CursorFeedbackSample {
        unsafe {
            let cursor_class = objc_getClass(c"NSCursor".as_ptr());
            if cursor_class.is_null() {
                return CursorFeedbackSample::new("unavailable", None);
            }

            let send_id: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void =
                mem::transmute(objc_msg_send as *const ());
            let send_bool: unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> i8 =
                mem::transmute(objc_msg_send as *const ());
            let send_i64: unsafe extern "C" fn(*mut c_void, *const c_void) -> i64 =
                mem::transmute(objc_msg_send as *const ());

            let current_selector = sel_registerName(c"currentSystemCursor".as_ptr());
            let cursor = send_id(cursor_class, current_selector);
            if cursor.is_null() {
                return CursorFeedbackSample::new("unavailable", None);
            }

            let core_type_selector = sel_registerName(c"_coreCursorType".as_ptr());
            let responds_selector = sel_registerName(c"respondsToSelector:".as_ptr());
            let responds = send_bool(cursor, responds_selector, core_type_selector) != 0;
            if responds {
                let core_type = send_i64(cursor, core_type_selector);
                let kind = match core_type {
                    0 => "normal",
                    4 => "busy",
                    _ => "other",
                };
                return CursorFeedbackSample::new(
                    kind,
                    Some(format!("coreCursorType:{core_type}")),
                );
            }

            CursorFeedbackSample::new("other", Some(format!("NSCursor:{cursor:p}")))
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::CursorFeedbackSample;

    pub fn sample_cursor_feedback() -> CursorFeedbackSample {
        CursorFeedbackSample::new("unavailable", None)
    }
}
