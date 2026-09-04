#![cfg(target_os = "macos")]

use std::{
    ffi::{c_void, CStr},
    os::raw::c_char,
    sync::OnceLock,
};

#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

#[link(name = "objc")]
extern "C" {
    fn object_getClass(object: *const c_void) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn class_addMethod(
        class: *mut c_void,
        selector: *const c_void,
        implementation: *const c_void,
        types: *const c_char,
    ) -> i8;
}

static INSTALL_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

pub fn allow_unconstrained_top_edge(window: &tauri::WebviewWindow) -> Result<(), String> {
    INSTALL_RESULT
        .get_or_init(|| unsafe { install_unconstrained_frame(window) })
        .clone()
}

unsafe fn install_unconstrained_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to access NSWindow: {error}"))?;
    if ns_window.is_null() {
        return Err("NSWindow pointer is unavailable".to_string());
    }

    let class = object_getClass(ns_window as *const c_void);
    if class.is_null() {
        return Err("NSWindow class is unavailable".to_string());
    }

    let selector_name = CStr::from_bytes_with_nul(b"constrainFrameRect:toScreen:\0")
        .map_err(|_| "constrainFrameRect selector name is invalid".to_string())?;
    let selector = sel_registerName(selector_name.as_ptr());
    if selector.is_null() {
        return Err("constrainFrameRect selector is unavailable".to_string());
    }

    // Tao's window class inherits AppKit's top-edge constraint. Adding the
    // method to the concrete class overrides the inherited implementation.
    let implementation = unconstrained_frame_rect as *const () as *const c_void;
    let types = CStr::from_bytes_with_nul(
        b"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@\0",
    )
    .map_err(|_| "constrainFrameRect type encoding is invalid".to_string())?;
    if class_addMethod(class, selector, implementation, types.as_ptr()) == 0 {
        return Err("failed to install unconstrained NSWindow frame override".to_string());
    }

    Ok(())
}

extern "C" fn unconstrained_frame_rect(
    _window: *mut c_void,
    _selector: *const c_void,
    frame: CgRect,
    _screen: *mut c_void,
) -> CgRect {
    frame
}
