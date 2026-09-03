#[cfg(target_os = "macos")]
mod platform {
    use std::{ffi::c_void, os::raw::c_char, ptr};

    type CfTypeRef = *const c_void;
    type CfStringRef = *const c_void;
    type CfDictionaryRef = *const c_void;
    type IoObject = u32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_DOUBLE_TYPE: i32 = 13;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *const c_void) -> IoObject;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CfStringRef,
            allocator: *const c_void,
            options: u32,
        ) -> CfTypeRef;
        fn IOObjectRelease(object: IoObject) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_string: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFDictionaryGetValueIfPresent(
            dictionary: CfDictionaryRef,
            key: *const c_void,
            value: *mut *const c_void,
        ) -> u8;
        fn CFGetTypeID(value: CfTypeRef) -> usize;
        fn CFDictionaryGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: CfTypeRef, number_type: i32, value: *mut c_void) -> u8;
        fn CFRelease(value: CfTypeRef);
    }

    pub struct GpuSampler {
        service: IoObject,
        statistics_key: CfStringRef,
        utilization_key: CfStringRef,
    }

    impl GpuSampler {
        pub fn new() -> Self {
            unsafe {
                let statistics_key = create_cf_string(b"PerformanceStatistics\0");
                let utilization_key = create_cf_string(b"Device Utilization %\0");
                let service = if statistics_key.is_null() || utilization_key.is_null() {
                    0
                } else {
                    find_gpu_service(statistics_key, utilization_key)
                };

                Self {
                    service,
                    statistics_key,
                    utilization_key,
                }
            }
        }

        pub fn sample(&mut self) -> Option<f32> {
            if self.service == 0 || self.statistics_key.is_null() || self.utilization_key.is_null()
            {
                return None;
            }

            unsafe {
                let statistics = IORegistryEntryCreateCFProperty(
                    self.service,
                    self.statistics_key,
                    ptr::null(),
                    0,
                );
                if statistics.is_null() {
                    return None;
                }

                let result = read_utilization(statistics, self.utilization_key);
                CFRelease(statistics);
                result
            }
        }
    }

    impl Default for GpuSampler {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Drop for GpuSampler {
        fn drop(&mut self) {
            unsafe {
                if self.service != 0 {
                    let _ = IOObjectRelease(self.service);
                }
                if !self.statistics_key.is_null() {
                    CFRelease(self.statistics_key);
                }
                if !self.utilization_key.is_null() {
                    CFRelease(self.utilization_key);
                }
            }
        }
    }

    unsafe fn find_gpu_service(
        statistics_key: CfStringRef,
        utilization_key: CfStringRef,
    ) -> IoObject {
        for class_name in [b"IOGPU\0".as_slice(), b"IOAccelerator\0".as_slice()] {
            let matching = IOServiceMatching(class_name.as_ptr().cast());
            if matching.is_null() {
                continue;
            }

            let service = IOServiceGetMatchingService(0, matching);
            if service == 0 {
                continue;
            }

            if service_has_utilization(service, statistics_key, utilization_key) {
                return service;
            }

            let _ = IOObjectRelease(service);
        }

        0
    }

    unsafe fn service_has_utilization(
        service: IoObject,
        statistics_key: CfStringRef,
        utilization_key: CfStringRef,
    ) -> bool {
        let statistics = IORegistryEntryCreateCFProperty(service, statistics_key, ptr::null(), 0);
        if statistics.is_null() {
            return false;
        }

        let available = read_utilization(statistics, utilization_key).is_some();
        CFRelease(statistics);
        available
    }

    unsafe fn create_cf_string(value: &[u8]) -> CfStringRef {
        CFStringCreateWithCString(
            ptr::null(),
            value.as_ptr().cast(),
            K_CF_STRING_ENCODING_UTF8,
        )
    }

    unsafe fn read_utilization(statistics: CfTypeRef, utilization_key: CfStringRef) -> Option<f32> {
        if CFGetTypeID(statistics) != CFDictionaryGetTypeID() {
            return None;
        }

        let mut raw_value: *const c_void = ptr::null();
        let found =
            CFDictionaryGetValueIfPresent(statistics.cast(), utilization_key, &mut raw_value);
        if found == 0 || raw_value.is_null() || CFGetTypeID(raw_value) != CFNumberGetTypeID() {
            return None;
        }

        let mut utilization = 0.0_f64;
        let converted = CFNumberGetValue(
            raw_value,
            K_CF_NUMBER_DOUBLE_TYPE,
            (&mut utilization as *mut f64).cast(),
        );
        if converted == 0 || !utilization.is_finite() {
            return None;
        }

        Some(utilization.clamp(0.0, 100.0) as f32)
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        collections::HashMap,
        ffi::c_void,
        ptr::{null, null_mut},
        slice,
    };

    type PdhStatus = i32;
    type PdhQuery = *mut c_void;
    type PdhCounter = *mut c_void;

    const ERROR_SUCCESS: PdhStatus = 0;
    const PDH_MORE_DATA: PdhStatus = 0x8000_07D2_u32 as i32;
    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_CSTATUS_VALID_DATA: u32 = 0x0000_0000;
    const PDH_CSTATUS_NEW_DATA: u32 = 0x0000_0001;

    #[repr(C)]
    union PdhFormattedValueUnion {
        double_value: f64,
    }

    #[repr(C)]
    struct PdhFormattedCounterValue {
        c_status: u32,
        value: PdhFormattedValueUnion,
    }

    #[repr(C)]
    struct PdhFormattedCounterValueItemW {
        name: *mut u16,
        value: PdhFormattedCounterValue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(
            data_source: *const u16,
            user_data: usize,
            query: *mut PdhQuery,
        ) -> PdhStatus;
        fn PdhAddEnglishCounterW(
            query: PdhQuery,
            counter_path: *const u16,
            user_data: usize,
            counter: *mut PdhCounter,
        ) -> PdhStatus;
        fn PdhCollectQueryData(query: PdhQuery) -> PdhStatus;
        fn PdhGetFormattedCounterArrayW(
            counter: PdhCounter,
            format: u32,
            buffer_size: *mut u32,
            item_count: *mut u32,
            item_buffer: *mut PdhFormattedCounterValueItemW,
        ) -> PdhStatus;
        fn PdhCloseQuery(query: PdhQuery) -> PdhStatus;
    }

    struct QueryHandles {
        query: PdhQuery,
        counter: PdhCounter,
    }

    pub struct GpuSampler {
        handles: Option<QueryHandles>,
    }

    impl GpuSampler {
        pub fn new() -> Self {
            Self {
                handles: unsafe { open_gpu_query() },
            }
        }

        pub fn sample(&mut self) -> Option<f32> {
            let handles = self.handles.as_ref()?;

            unsafe {
                if PdhCollectQueryData(handles.query) != ERROR_SUCCESS {
                    return None;
                }

                formatted_gpu_utilization(handles.counter)
            }
        }
    }

    impl Default for GpuSampler {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Drop for GpuSampler {
        fn drop(&mut self) {
            if let Some(handles) = self.handles.take() {
                unsafe {
                    let _ = PdhCloseQuery(handles.query);
                }
            }
        }
    }

    unsafe fn open_gpu_query() -> Option<QueryHandles> {
        let mut query = null_mut();
        if PdhOpenQueryW(null(), 0, &mut query) != ERROR_SUCCESS || query.is_null() {
            return None;
        }

        let counter_path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0"
            .encode_utf16()
            .collect();
        let mut counter = null_mut();
        if PdhAddEnglishCounterW(query, counter_path.as_ptr(), 0, &mut counter) != ERROR_SUCCESS
            || counter.is_null()
        {
            let _ = PdhCloseQuery(query);
            return None;
        }

        if PdhCollectQueryData(query) != ERROR_SUCCESS {
            let _ = PdhCloseQuery(query);
            return None;
        }

        Some(QueryHandles { query, counter })
    }

    unsafe fn formatted_gpu_utilization(counter: PdhCounter) -> Option<f32> {
        let mut buffer_size = 0_u32;
        let mut item_count = 0_u32;
        let status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            null_mut(),
        );
        if status != PDH_MORE_DATA || buffer_size == 0 {
            return None;
        }

        let slot_size = std::mem::size_of::<u64>();
        let slot_count = (buffer_size as usize + slot_size - 1) / slot_size;
        let mut buffer = vec![0_u64; slot_count];
        let status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            buffer.as_mut_ptr().cast(),
        );
        if status != ERROR_SUCCESS || item_count == 0 {
            return None;
        }

        let items = slice::from_raw_parts(
            buffer.as_ptr().cast::<PdhFormattedCounterValueItemW>(),
            item_count as usize,
        );
        let mut engines = HashMap::<String, f64>::new();

        for item in items {
            if item.value.c_status != PDH_CSTATUS_VALID_DATA
                && item.value.c_status != PDH_CSTATUS_NEW_DATA
            {
                continue;
            }

            let utilization = item.value.value.double_value;
            if !utilization.is_finite() || utilization < 0.0 {
                continue;
            }

            let Some(name) = wide_string(item.name) else {
                continue;
            };
            let key = engine_key(&name).to_owned();
            *engines.entry(key).or_default() += utilization;
        }

        engines
            .values()
            .copied()
            .reduce(f64::max)
            .map(|value| value.clamp(0.0, 100.0) as f32)
    }

    unsafe fn wide_string(value: *const u16) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let mut length = 0_usize;
        while length < 4096 && *value.add(length) != 0 {
            length += 1;
        }
        if length == 4096 {
            return None;
        }

        Some(String::from_utf16_lossy(slice::from_raw_parts(
            value, length,
        )))
    }

    fn engine_key(instance_name: &str) -> &str {
        instance_name
            .find("_luid_")
            .map(|index| &instance_name[index..])
            .unwrap_or(instance_name)
    }

    #[cfg(test)]
    mod tests {
        use super::engine_key;

        #[test]
        fn engine_key_discards_process_identity() {
            assert_eq!(
                engine_key("pid_100_luid_0x00000000_0x00001234_phys_0_eng_1_engtype_3D"),
                "_luid_0x00000000_0x00001234_phys_0_eng_1_engtype_3D"
            );
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    #[derive(Default)]
    pub struct GpuSampler;

    impl GpuSampler {
        pub fn new() -> Self {
            Self
        }

        pub fn sample(&mut self) -> Option<f32> {
            None
        }
    }
}

pub use platform::GpuSampler;
