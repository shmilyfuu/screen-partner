const SYSTEM_METRICS_EVENT = "system-metrics";
const NEW_TRIGGER_LABELS = Object.freeze({
  disk_pressure: "Disk Pressure",
  disk_pressure_network: "Disk Pressure+Network",
  disk_pressure_network_active: "Disk Pressure+Network",
  cursor_busy: "Cursor Busy",
  cursor_working: "Cursor Working",
  cursor_background_working: "Cursor Working",
});

const metricsElement = document.querySelector("[data-debug-metrics]");
const triggerElement = document.querySelector("[data-debug-current-trigger]");
let unlisten = null;
let latestMetrics = null;

function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) {
    return "--".padStart(7);
  }

  const units = [
    [1024 ** 4, "T"],
    [1024 ** 3, "G"],
    [1024 ** 2, "M"],
    [1024, "K"],
  ];

  for (const [factor, suffix] of units) {
    if (value >= factor) {
      const amount = Math.min(value / factor, 999.9);
      return `${amount.toFixed(1)}${suffix}`.padStart(7);
    }
  }

  return `${Math.min(Math.round(value), 1023)}B`.padStart(7);
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "--".padStart(4);
  }
  const number = Number(value);
  const formatted = Number.isFinite(number) ? `${Math.round(number)}%` : "--";
  return formatted.padStart(4);
}

function formatLatency(value) {
  if (value === null || value === undefined) {
    return "--".padStart(7);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return "--".padStart(7);
  }
  const clamped = Math.min(number, 9999);
  const digits = clamped >= 100 ? 0 : clamped >= 10 ? 1 : 2;
  return `${clamped.toFixed(digits)}ms`.padStart(7);
}

function formatCursor(value) {
  switch (value) {
    case "busy":
      return "Busy";
    case "background_working":
      return "Working";
    case "normal":
      return "Normal";
    case "other":
      return "Other";
    default:
      return "N/A";
  }
}

function renderMetrics(metrics) {
  if (!metricsElement || !metrics) {
    return;
  }

  metricsElement.textContent =
    `CPU ${formatPercent(metrics.cpuUsagePercent)}  |  GPU ${formatPercent(metrics.gpuUsagePercent)}  |  RAM ${formatPercent(metrics.memoryUsagePercent)}\n` +
    `D ${formatRate(metrics.diskReadBps)}/${formatRate(metrics.diskWriteBps)}  |  ` +
    `N ${formatRate(metrics.networkRxBps)}/${formatRate(metrics.networkTxBps)}\n` +
    `DP ${formatPercent(metrics.diskBusyPercent)}/${formatLatency(metrics.diskLatencyMs)}  |  ` +
    `C ${formatCursor(metrics.cursorFeedback)}`;
}

function installTriggerLabels() {
  if (!triggerElement) {
    return;
  }

  const replaceKnownLabel = () => {
    const label = NEW_TRIGGER_LABELS[triggerElement.textContent];
    if (label) {
      triggerElement.textContent = label;
    }
  };

  replaceKnownLabel();
  new MutationObserver(replaceKnownLabel).observe(triggerElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

async function initialize() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  const listen = globalThis.__TAURI__?.event?.listen;
  if (typeof invoke !== "function" || typeof listen !== "function") {
    return;
  }

  try {
    if (!(await invoke("development_ui_enabled"))) {
      return;
    }
    installTriggerLabels();
    if (metricsElement) {
      new MutationObserver(() => {
        if (latestMetrics && !metricsElement.textContent.includes("\nDP ")) {
          queueMicrotask(() => renderMetrics(latestMetrics));
        }
      }).observe(metricsElement, { childList: true, characterData: true, subtree: true });
    }
    unlisten = await listen(SYSTEM_METRICS_EVENT, (event) => {
      latestMetrics = event.payload;
      queueMicrotask(() => renderMetrics(latestMetrics));
    });
  } catch (error) {
    console.warn("[screen-partner] extended debug metrics unavailable", error);
  }
}

window.addEventListener("beforeunload", () => {
  if (typeof unlisten === "function") {
    unlisten();
  }
});

void initialize();
