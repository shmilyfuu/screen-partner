use std::{ffi::c_void, os::raw::c_char};

#[repr(C)]
#[derive(Clone, Copy)]
struct NsPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NsSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NsRect {
    origin: NsPoint,
    size: NsSize,
}

#[link(name = "objc")]
unsafe extern "C" {
    fn object_getClass(object: *const c_void) -> *mut c_void;
    fn object_setClass(object: *mut c_void, class: *mut c_void) -> *mut c_void;
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn objc_allocateClassPair(
        superclass: *const c_void,
        name: *const c_char,
        extra_bytes: usize,
    ) -> *mut c_void;
    fn objc_registerClassPair(class: *mut c_void);
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn class_getInstanceMethod(class: *const c_void, selector: *const c_void) -> *mut c_void;
    fn method_getTypeEncoding(method: *const c_void) -> *const c_char;
    fn class_addMethod(
        class: *mut c_void,
        selector: *const c_void,
        implementation: *const c_void,
        types: *const c_char,
    ) -> bool;
}

const SUBCLASS_NAME: &[u8] = b"ScreenPartnerUnrestrictedWindow\0";
const CONSTRAIN_SELECTOR: &[u8] = b"constrainFrameRect:toScreen:\0";

pub fn enable_unrestricted_drag(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to access NSWindow: {error}"))?;
    if ns_window.is_null() {
        return Err("Tauri returned a null NSWindow".to_string());
    }

    unsafe {
        let current_class = object_getClass(ns_window.cast_const());
        if current_class.is_null() {
            return Err("failed to read NSWindow class".to_string());
        }

        let subclass_name = SUBCLASS_NAME.as_ptr().cast::<c_char>();
        let mut subclass = objc_getClass(subclass_name);
        if subclass.is_null() {
            subclass = objc_allocateClassPair(current_class, subclass_name, 0);
            if subclass.is_null() {
                return Err("failed to create unrestricted NSWindow subclass".to_string());
            }

            let selector = sel_registerName(CONSTRAIN_SELECTOR.as_ptr().cast());
            if selector.is_null() {
                return Err("failed to resolve constrainFrameRect selector".to_string());
            }

            let inherited_method = class_getInstanceMethod(current_class, selector);
            if inherited_method.is_null() {
                return Err("NSWindow constrainFrameRect method is unavailable".to_string());
            }

            let type_encoding = method_getTypeEncoding(inherited_method);
            if type_encoding.is_null() {
                return Err("failed to read constrainFrameRect type encoding".to_string());
            }

            let added = class_addMethod(
                subclass,
                selector,
                unconstrained_frame_rect as *const c_void,
                type_encoding,
            );
            if !added {
                return Err("failed to override constrainFrameRect".to_string());
            }

            objc_registerClassPair(subclass);
        }

        object_setClass(ns_window, subclass);
    }

    Ok(())
}

unsafe extern "C" fn unconstrained_frame_rect(
    _window: *mut c_void,
    _selector: *mut c_void,
    proposed_frame: NsRect,
    _screen: *mut c_void,
) -> NsRect {
    proposed_frame
}
