#[path = "disk_pressure.rs"]
mod disk_pressure;
#[path = "platform_feedback.rs"]
mod platform_feedback;

use crate::gpu::GpuSampler;
use disk_pressure::DiskPressureSampler;
use platform_feedback::sample_cursor_feedback;
use serde::Serialize;
use std::{
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Disks, Networks, System};
use tauri::{AppHandle, Emitter};

pub const TELEMETRY_EVENT: &str = "system-metrics";
pub const TELEMETRY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    pub timestamp_ms: u64,
    pub cpu_usage_percent: f32,
    pub gpu_usage_percent: Option<f32>,
    pub memory_usage_percent: f32,
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    pub disk_activity_device: Option<String>,
    pub disk_busy_percent: Option<f32>,
    pub disk_latency_ms: Option<f32>,
    pub disk_pressure_device: Option<String>,
    pub network_rx_bps: u64,
    pub network_tx_bps: u64,
    pub network_activity_interface: Option<String>,
    pub cursor_feedback: String,
    pub cursor_feedback_detail: Option<String>,
    pub cursor_feedback_token: Option<i64>,
    pub user_idle_seconds: Option<u64>,
}

pub struct TelemetrySampler {
    system: System,
    gpu: GpuSampler,
    disks: Disks,
    disk_pressure: DiskPressureSampler,
    networks: Networks,
    last_sampled_at: Instant,
}

impl TelemetrySampler {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        system.refresh_memory();

        let gpu = GpuSampler::new();

        let mut disks = Disks::new_with_refreshed_list();
        disks.refresh(true);

        let disk_pressure = DiskPressureSampler::new();

        let mut networks = Networks::new_with_refreshed_list();
        networks.refresh(true);

        Self {
            system,
            gpu,
            disks,
            disk_pressure,
            networks,
            last_sampled_at: Instant::now(),
        }
    }

    pub fn sample(&mut self) -> SystemMetrics {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);
        self.networks.refresh(true);

        let sampled_at = Instant::now();
        let elapsed = sampled_at.saturating_duration_since(self.last_sampled_at);
        self.last_sampled_at = sampled_at;

        let (disk_read_bps, disk_write_bps, disk_activity_device) =
            busiest_disk_rates(&self.disks, elapsed);
        let disk_pressure = self.disk_pressure.sample();
        let (network_rx_bps, network_tx_bps, network_activity_interface) =
            busiest_network_rates(&self.networks, elapsed);
        let cursor_feedback = sample_cursor_feedback();

        SystemMetrics {
            timestamp_ms: unix_timestamp_ms(),
            cpu_usage_percent: self.system.global_cpu_usage().clamp(0.0, 100.0),
            gpu_usage_percent: self.gpu.sample(),
            memory_usage_percent: memory_usage_percent(
                self.system.used_memory(),
                self.system.total_memory(),
            ),
            disk_read_bps,
            disk_write_bps,
            disk_activity_device,
            disk_busy_percent: disk_pressure.busy_percent,
            disk_latency_ms: disk_pressure.latency_ms,
            disk_pressure_device: disk_pressure.device,
            network_rx_bps,
            network_tx_bps,
            network_activity_interface,
            cursor_feedback: cursor_feedback.kind,
            cursor_feedback_detail: cursor_feedback.raw,
            cursor_feedback_token: None,
            user_idle_seconds: None,
        }
    }
}

impl Default for TelemetrySampler {
    fn default() -> Self {
        Self::new()
    }
}

pub fn start_telemetry(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("screen-partner-telemetry".to_string())
        .spawn(move || {
            let mut sampler = TelemetrySampler::new();

            loop {
                thread::sleep(TELEMETRY_INTERVAL);
                let metrics = sampler.sample();

                if let Err(error) = app.emit(TELEMETRY_EVENT, metrics) {
                    eprintln!("[screen-partner] failed to emit telemetry: {error}");
                }
            }
        });
}

fn busiest_disk_rates(disks: &Disks, elapsed: Duration) -> (u64, u64, Option<String>) {
    disks
        .list()
        .iter()
        .map(|disk| {
            let usage = disk.usage();
            let read_bps = bytes_per_second(usage.read_bytes, elapsed);
            let write_bps = bytes_per_second(usage.written_bytes, elapsed);
            (
                read_bps,
                write_bps,
                Some(disk.name().to_string_lossy().into_owned()),
            )
        })
        .max_by_key(|(read_bps, write_bps, _)| read_bps.saturating_add(*write_bps))
        .unwrap_or((0, 0, None))
}

fn busiest_network_rates(
    networks: &Networks,
    elapsed: Duration,
) -> (u64, u64, Option<String>) {
    networks
        .iter()
        .map(|(name, data)| {
            let rx_bps = bytes_per_second(data.received(), elapsed);
            let tx_bps = bytes_per_second(data.transmitted(), elapsed);
            (rx_bps, tx_bps, Some(name.clone()))
        })
        .max_by_key(|(rx_bps, tx_bps, _)| rx_bps.saturating_add(*tx_bps))
        .unwrap_or((0, 0, None))
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn memory_usage_percent(used_bytes: u64, total_bytes: u64) -> f32 {
    if total_bytes == 0 {
        return 0.0;
    }

    ((used_bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0) as f32
}

fn bytes_per_second(delta_bytes: u64, elapsed: Duration) -> u64 {
    let seconds = elapsed.as_secs_f64();
    if seconds <= f64::EPSILON {
        return 0;
    }

    let rate = delta_bytes as f64 / seconds;
    rate.round().clamp(0.0, u64::MAX as f64) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_percentage_handles_normal_and_empty_totals() {
        assert_eq!(memory_usage_percent(25, 100), 25.0);
        assert_eq!(memory_usage_percent(0, 0), 0.0);
        assert_eq!(memory_usage_percent(150, 100), 100.0);
    }

    #[test]
    fn byte_delta_is_normalized_by_elapsed_time() {
        assert_eq!(bytes_per_second(1_000, Duration::from_millis(500)), 2_000);
        assert_eq!(bytes_per_second(1_000, Duration::ZERO), 0);
    }

    #[test]
    fn metrics_serialize_with_renderer_field_names() {
        let metrics = SystemMetrics {
            timestamp_ms: 123,
            cpu_usage_percent: 12.5,
            gpu_usage_percent: Some(56.25),
            memory_usage_percent: 34.5,
            disk_read_bps: 10,
            disk_write_bps: 20,
            disk_activity_device: Some("Disk 0".to_string()),
            disk_busy_percent: Some(70.0),
            disk_latency_ms: Some(12.5),
            disk_pressure_device: Some("Disk 0".to_string()),
            network_rx_bps: 30,
            network_tx_bps: 40,
            network_activity_interface: Some("Ethernet".to_string()),
            cursor_feedback: "busy".to_string(),
            cursor_feedback_detail: Some("IDC_WAIT".to_string()),
            cursor_feedback_token: None,
            user_idle_seconds: None,
        };

        let value = serde_json::to_value(metrics).expect("metrics should serialize");
        assert_eq!(value["timestampMs"], 123);
        assert_eq!(value["cpuUsagePercent"], 12.5);
        assert_eq!(value["gpuUsagePercent"], 56.25);
        assert_eq!(value["memoryUsagePercent"], 34.5);
        assert_eq!(value["diskReadBps"], 10);
        assert_eq!(value["diskWriteBps"], 20);
        assert_eq!(value["diskActivityDevice"], "Disk 0");
        assert_eq!(value["diskBusyPercent"], 70.0);
        assert_eq!(value["diskLatencyMs"], 12.5);
        assert_eq!(value["diskPressureDevice"], "Disk 0");
        assert_eq!(value["networkRxBps"], 30);
        assert_eq!(value["networkTxBps"], 40);
        assert_eq!(value["networkActivityInterface"], "Ethernet");
        assert_eq!(value["cursorFeedback"], "busy");
        assert_eq!(value["cursorFeedbackDetail"], "IDC_WAIT");
        assert!(value["cursorFeedbackToken"].is_null());
        assert!(value["userIdleSeconds"].is_null());
    }
}
