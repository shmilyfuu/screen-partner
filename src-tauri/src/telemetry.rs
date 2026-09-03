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
    pub memory_usage_percent: f32,
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    pub network_rx_bps: u64,
    pub network_tx_bps: u64,
    pub user_idle_seconds: Option<u64>,
}

pub struct TelemetrySampler {
    system: System,
    disks: Disks,
    networks: Networks,
    last_sampled_at: Instant,
}

impl TelemetrySampler {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        system.refresh_memory();

        let mut disks = Disks::new_with_refreshed_list();
        disks.refresh();

        let mut networks = Networks::new_with_refreshed_list();
        networks.refresh();

        Self {
            system,
            disks,
            networks,
            last_sampled_at: Instant::now(),
        }
    }

    pub fn sample(&mut self) -> SystemMetrics {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh();
        self.networks.refresh();

        let sampled_at = Instant::now();
        let elapsed = sampled_at.saturating_duration_since(self.last_sampled_at);
        self.last_sampled_at = sampled_at;

        let disk_read_bytes = self
            .disks
            .list()
            .iter()
            .map(|disk| disk.usage().read_bytes)
            .sum();
        let disk_write_bytes = self
            .disks
            .list()
            .iter()
            .map(|disk| disk.usage().written_bytes)
            .sum();
        let network_rx_bytes = self.networks.iter().map(|(_, data)| data.received()).sum();
        let network_tx_bytes = self
            .networks
            .iter()
            .map(|(_, data)| data.transmitted())
            .sum();

        SystemMetrics {
            timestamp_ms: unix_timestamp_ms(),
            cpu_usage_percent: self.system.global_cpu_usage().clamp(0.0, 100.0),
            memory_usage_percent: memory_usage_percent(
                self.system.used_memory(),
                self.system.total_memory(),
            ),
            disk_read_bps: bytes_per_second(disk_read_bytes, elapsed),
            disk_write_bps: bytes_per_second(disk_write_bytes, elapsed),
            network_rx_bps: bytes_per_second(network_rx_bytes, elapsed),
            network_tx_bps: bytes_per_second(network_tx_bytes, elapsed),
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
            memory_usage_percent: 34.5,
            disk_read_bps: 10,
            disk_write_bps: 20,
            network_rx_bps: 30,
            network_tx_bps: 40,
            user_idle_seconds: None,
        };

        let value = serde_json::to_value(metrics).expect("metrics should serialize");
        assert_eq!(value["timestampMs"], 123);
        assert_eq!(value["cpuUsagePercent"], 12.5);
        assert_eq!(value["memoryUsagePercent"], 34.5);
        assert_eq!(value["diskReadBps"], 10);
        assert_eq!(value["diskWriteBps"], 20);
        assert_eq!(value["networkRxBps"], 30);
        assert_eq!(value["networkTxBps"], 40);
        assert!(value["userIdleSeconds"].is_null());
    }
}
