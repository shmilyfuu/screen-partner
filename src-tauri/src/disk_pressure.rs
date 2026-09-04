use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskPressureSample {
    pub busy_percent: Option<f32>,
    pub latency_ms: Option<f32>,
    pub device: Option<String>,
}

pub struct DiskPressureSampler {
    platform: platform::Sampler,
}

impl DiskPressureSampler {
    pub fn new() -> Self {
        Self {
            platform: platform::Sampler::new(),
        }
    }

    pub fn sample(&mut self) -> DiskPressureSample {
        self.platform.sample()
    }
}

impl Default for DiskPressureSampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
mod platform {
    use super::DiskPressureSample;
    use std::{collections::HashMap, ffi::c_void, ptr};

    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const PDH_CSTATUS_VALID_DATA: u32 = 0x0000_0000;
    const PDH_CSTATUS_NEW_DATA: u32 = 0x0000_0001;

    #[repr(C)]
    union PdhValue {
        long_value: i32,
        double_value: f64,
        large_value: i64,
        ansi_string_value: *mut i8,
        wide_string_value: *mut u16,
    }

    #[repr(C)]
    struct PdhFmtCounterValue {
        c_status: u32,
        value: PdhValue,
    }

    #[repr(C)]
    struct PdhFmtCounterValueItemW {
        name: *mut u16,
        value: PdhFmtCounterValue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(data_source: *const u16, user_data: usize, query: *mut *mut c_void)
            -> i32;
        fn PdhAddEnglishCounterW(
            query: *mut c_void,
            full_counter_path: *const u16,
            user_data: usize,
            counter: *mut *mut c_void,
        ) -> i32;
        fn PdhCollectQueryData(query: *mut c_void) -> i32;
        fn PdhGetFormattedCounterArrayW(
            counter: *mut c_void,
            format: u32,
            buffer_size: *mut u32,
            item_count: *mut u32,
            item_buffer: *mut c_void,
        ) -> i32;
        fn PdhCloseQuery(query: *mut c_void) -> i32;
    }

    pub struct Sampler {
        query: *mut c_void,
        busy_counter: *mut c_void,
        latency_counter: *mut c_void,
        ready: bool,
    }

    unsafe impl Send for Sampler {}

    impl Sampler {
        pub fn new() -> Self {
            let mut sampler = Self {
                query: ptr::null_mut(),
                busy_counter: ptr::null_mut(),
                latency_counter: ptr::null_mut(),
                ready: false,
            };
            sampler.ready = unsafe { sampler.initialize() };
            sampler
        }

        pub fn sample(&mut self) -> DiskPressureSample {
            if !self.ready {
                return DiskPressureSample::default();
            }

            let status = unsafe { PdhCollectQueryData(self.query) };
            if status != 0 {
                return DiskPressureSample::default();
            }

            let busy = unsafe { formatted_array(self.busy_counter) }.unwrap_or_default();
            let latency = unsafe { formatted_array(self.latency_counter) }.unwrap_or_default();
            select_pressure_sample(&busy, &latency)
        }

        unsafe fn initialize(&mut self) -> bool {
            if PdhOpenQueryW(ptr::null(), 0, &mut self.query) != 0 || self.query.is_null() {
                return false;
            }

            let busy_path = wide("\\PhysicalDisk(*)\\% Disk Time");
            if PdhAddEnglishCounterW(self.query, busy_path.as_ptr(), 0, &mut self.busy_counter) != 0
            {
                return false;
            }

            let latency_path = wide("\\PhysicalDisk(*)\\Avg. Disk sec/Transfer");
            if PdhAddEnglishCounterW(
                self.query,
                latency_path.as_ptr(),
                0,
                &mut self.latency_counter,
            ) != 0
            {
                return false;
            }

            PdhCollectQueryData(self.query) == 0
        }
    }

    impl Drop for Sampler {
        fn drop(&mut self) {
            if !self.query.is_null() {
                unsafe {
                    PdhCloseQuery(self.query);
                }
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn formatted_array(counter: *mut c_void) -> Option<Vec<(String, f64)>> {
        let mut buffer_size = 0u32;
        let mut item_count = 0u32;
        let first_status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            ptr::null_mut(),
        );
        if first_status as u32 != PDH_MORE_DATA || buffer_size == 0 {
            return None;
        }

        let word_count = (buffer_size as usize).div_ceil(std::mem::size_of::<usize>());
        let mut buffer = vec![0usize; word_count];
        let second_status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buffer_size,
            &mut item_count,
            buffer.as_mut_ptr().cast(),
        );
        if second_status != 0 {
            return None;
        }

        let items = std::slice::from_raw_parts(
            buffer.as_ptr().cast::<PdhFmtCounterValueItemW>(),
            item_count as usize,
        );
        let mut values = Vec::with_capacity(items.len());
        for item in items {
            if item.name.is_null()
                || (item.value.c_status != PDH_CSTATUS_VALID_DATA
                    && item.value.c_status != PDH_CSTATUS_NEW_DATA)
            {
                continue;
            }

            let name = wide_ptr_to_string(item.name);
            if name == "_Total" || name.is_empty() {
                continue;
            }

            let value = item.value.value.double_value;
            if value.is_finite() && value >= 0.0 {
                values.push((name, value));
            }
        }
        Some(values)
    }

    unsafe fn wide_ptr_to_string(value: *const u16) -> String {
        let mut len = 0usize;
        while *value.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
    }

    fn select_pressure_sample(
        busy_values: &[(String, f64)],
        latency_values: &[(String, f64)],
    ) -> DiskPressureSample {
        let latency_by_name: HashMap<&str, f64> = latency_values
            .iter()
            .map(|(name, value)| (name.as_str(), *value * 1_000.0))
            .collect();

        let mut best: Option<(f64, DiskPressureSample)> = None;
        for (name, busy) in busy_values {
            let busy_percent = busy.clamp(0.0, 100.0);
            let latency_ms = latency_by_name.get(name.as_str()).copied();
            let score = (busy_percent / 70.0).max(latency_ms.unwrap_or(0.0) / 20.0);
            let sample = DiskPressureSample {
                busy_percent: Some(busy_percent as f32),
                latency_ms: latency_ms.map(|value| value as f32),
                device: Some(name.clone()),
            };
            if should_replace(&best, score) {
                best = Some((score, sample));
            }
        }

        for (name, latency_seconds) in latency_values {
            if busy_values.iter().any(|(busy_name, _)| busy_name == name) {
                continue;
            }
            let latency_ms = *latency_seconds * 1_000.0;
            let score = latency_ms / 20.0;
            let sample = DiskPressureSample {
                busy_percent: None,
                latency_ms: Some(latency_ms as f32),
                device: Some(name.clone()),
            };
            if should_replace(&best, score) {
                best = Some((score, sample));
            }
        }

        best.map(|(_, sample)| sample).unwrap_or_default()
    }

    fn should_replace(best: &Option<(f64, DiskPressureSample)>, score: f64) -> bool {
        match best {
            None => true,
            Some((best_score, _)) => score > *best_score,
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::DiskPressureSample;
    use std::{
        collections::HashMap,
        ffi::{c_char, c_void},
        ptr,
        time::Instant,
    };

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT64_TYPE: i32 = 4;
    const KERN_SUCCESS: i32 = 0;

    type IoObject = u32;
    type CfTypeRef = *const c_void;
    type CfDictionaryRef = *const c_void;
    type CfMutableDictionaryRef = *mut c_void;
    type CfStringRef = *const c_void;

    #[derive(Clone, Copy, Default)]
    struct RawStats {
        operations: u64,
        total_time_ns: u64,
        latency_time_ns: u64,
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> CfMutableDictionaryRef;
        fn IOServiceGetMatchingServices(
            main_port: u32,
            matching: CfDictionaryRef,
            existing: *mut IoObject,
        ) -> i32;
        fn IOIteratorNext(iterator: IoObject) -> IoObject;
        fn IOObjectRelease(object: IoObject) -> i32;
        fn IORegistryEntryCreateCFProperties(
            entry: IoObject,
            properties: *mut CfMutableDictionaryRef,
            allocator: *const c_void,
            options: u32,
        ) -> i32;
        fn IORegistryEntryGetRegistryEntryID(entry: IoObject, entry_id: *mut u64) -> i32;
        fn IORegistryEntryGetName(entry: IoObject, name: *mut c_char) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFDictionaryGetValue(dictionary: CfDictionaryRef, key: CfTypeRef) -> CfTypeRef;
        fn CFNumberGetValue(number: CfTypeRef, number_type: i32, value: *mut c_void) -> u8;
        fn CFRelease(value: CfTypeRef);
    }

    pub struct Sampler {
        previous: HashMap<u64, (String, RawStats)>,
        last_sampled_at: Instant,
    }

    impl Sampler {
        pub fn new() -> Self {
            Self {
                previous: unsafe { snapshot() },
                last_sampled_at: Instant::now(),
            }
        }

        pub fn sample(&mut self) -> DiskPressureSample {
            let now = Instant::now();
            let elapsed_ns = now
                .saturating_duration_since(self.last_sampled_at)
                .as_nanos()
                .max(1) as f64;
            self.last_sampled_at = now;

            let current = unsafe { snapshot() };
            let mut best: Option<(f64, DiskPressureSample)> = None;
            for (id, (name, stats)) in &current {
                let Some((_, previous)) = self.previous.get(id) else {
                    continue;
                };

                let operations = stats.operations.saturating_sub(previous.operations);
                let total_time_ns = stats.total_time_ns.saturating_sub(previous.total_time_ns);
                let latency_time_ns = stats
                    .latency_time_ns
                    .saturating_sub(previous.latency_time_ns);
                let busy_percent = ((total_time_ns as f64 / elapsed_ns) * 100.0).clamp(0.0, 100.0);
                let latency_ms = if operations > 0 {
                    Some(latency_time_ns as f64 / operations as f64 / 1_000_000.0)
                } else {
                    Some(0.0)
                };
                let score = (busy_percent / 70.0).max(latency_ms.unwrap_or(0.0) / 20.0);
                let sample = DiskPressureSample {
                    busy_percent: Some(busy_percent as f32),
                    latency_ms: latency_ms.map(|value| value as f32),
                    device: Some(format!("{name}#{id}")),
                };
                if should_replace(&best, score) {
                    best = Some((score, sample));
                }
            }

            self.previous = current;
            best.map(|(_, sample)| sample).unwrap_or_default()
        }
    }

    fn should_replace(best: &Option<(f64, DiskPressureSample)>, score: f64) -> bool {
        match best {
            None => true,
            Some((best_score, _)) => score > *best_score,
        }
    }

    unsafe fn snapshot() -> HashMap<u64, (String, RawStats)> {
        let matching = IOServiceMatching(c"IOBlockStorageDriver".as_ptr());
        if matching.is_null() {
            return HashMap::new();
        }

        let mut iterator = 0;
        if IOServiceGetMatchingServices(0, matching, &mut iterator) != KERN_SUCCESS || iterator == 0
        {
            return HashMap::new();
        }

        let mut result = HashMap::new();
        loop {
            let entry = IOIteratorNext(iterator);
            if entry == 0 {
                break;
            }

            let mut id = 0u64;
            if IORegistryEntryGetRegistryEntryID(entry, &mut id) == KERN_SUCCESS {
                if let Some(stats) = read_stats(entry) {
                    result.insert(id, (entry_name(entry), stats));
                }
            }
            IOObjectRelease(entry);
        }
        IOObjectRelease(iterator);
        result
    }

    unsafe fn entry_name(entry: IoObject) -> String {
        let mut buffer = [0i8; 128];
        if IORegistryEntryGetName(entry, buffer.as_mut_ptr()) != KERN_SUCCESS {
            return "disk".to_string();
        }
        let len = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        let bytes = std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), len);
        String::from_utf8_lossy(bytes).into_owned()
    }

    unsafe fn read_stats(entry: IoObject) -> Option<RawStats> {
        let mut properties: CfMutableDictionaryRef = ptr::null_mut();
        if IORegistryEntryCreateCFProperties(entry, &mut properties, ptr::null(), 0) != KERN_SUCCESS
            || properties.is_null()
        {
            return None;
        }

        let statistics_key = cf_string(c"Statistics".as_ptr());
        if statistics_key.is_null() {
            CFRelease(properties);
            return None;
        }
        let statistics = CFDictionaryGetValue(properties, statistics_key);
        CFRelease(statistics_key);
        if statistics.is_null() {
            CFRelease(properties);
            return None;
        }

        let reads = dictionary_u64(statistics, c"Operations (Read)".as_ptr()).unwrap_or(0);
        let writes = dictionary_u64(statistics, c"Operations (Write)".as_ptr()).unwrap_or(0);
        let total_read = dictionary_u64(statistics, c"Total Time (Read)".as_ptr()).unwrap_or(0);
        let total_write = dictionary_u64(statistics, c"Total Time (Write)".as_ptr()).unwrap_or(0);
        let latent_read = dictionary_u64(statistics, c"Latency Time (Read)".as_ptr()).unwrap_or(0);
        let latent_write =
            dictionary_u64(statistics, c"Latency Time (Write)".as_ptr()).unwrap_or(0);
        CFRelease(properties);

        Some(RawStats {
            operations: reads.saturating_add(writes),
            total_time_ns: total_read.saturating_add(total_write),
            latency_time_ns: latent_read.saturating_add(latent_write),
        })
    }

    unsafe fn dictionary_u64(dictionary: CfDictionaryRef, key: *const c_char) -> Option<u64> {
        let key = cf_string(key);
        if key.is_null() {
            return None;
        }
        let number = CFDictionaryGetValue(dictionary, key);
        CFRelease(key);
        if number.is_null() {
            return None;
        }

        let mut value = 0i64;
        if CFNumberGetValue(
            number,
            K_CF_NUMBER_SINT64_TYPE,
            (&mut value as *mut i64).cast(),
        ) != 0
            && value >= 0
        {
            Some(value as u64)
        } else {
            None
        }
    }

    unsafe fn cf_string(value: *const c_char) -> CfStringRef {
        CFStringCreateWithCString(ptr::null(), value, K_CF_STRING_ENCODING_UTF8)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::DiskPressureSample;

    pub struct Sampler;

    impl Sampler {
        pub fn new() -> Self {
            Self
        }

        pub fn sample(&mut self) -> DiskPressureSample {
            DiskPressureSample::default()
        }
    }
}
