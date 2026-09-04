import { DECISION_PRIORITY } from "./behavior-arbiter.js";
import { SystemClock } from "./clock.js";

export const SYSTEM_SIGNAL_KEYS = Object.freeze({
  fallback: "system-default",
  waiting: "system-waiting",
  load: "system-load",
  pressure: "system-pressure",
});

export const DEFAULT_SYSTEM_BEHAVIOR_RULES = Object.freeze({
  cpu: Object.freeze({
    enterPercent: 75,
    exitPercent: 60,
    enterDurationMs: 5_000,
    exitDurationMs: 8_000,
  }),
  gpu: Object.freeze({
    enterPercent: 80,
    exitPercent: 60,
    enterDurationMs: 5_000,
    exitDurationMs: 8_000,
  }),
  memoryPressure: Object.freeze({
    enterPercent: 92,
    exitPercent: 85,
    enterDurationMs: 12_000,
    exitDurationMs: 10_000,
  }),
  disk: Object.freeze({
    enterBps: 4_000_000,
    exitBps: 1_000_000,
    enterDurationMs: 3_000,
    exitDurationMs: 5_000,
  }),
  network: Object.freeze({
    enterBps: 1_500_000,
    exitBps: 400_000,
    enterDurationMs: 3_000,
    exitDurationMs: 5_000,
  }),
  waiting: Object.freeze({
    userIdleSeconds: 60,
    maxCpuPercent: 8,
    maxGpuPercent: 15,
    maxMemoryPercent: 68,
    maxDiskBps: 200_000,
    maxNetworkBps: 100_000,
  }),
  maxSampleGapMs: 2_500,
});

class TimedHysteresisGate {
  #enterDurationMs;
  #exitDurationMs;
  #active = false;
  #enterSince = null;
  #exitSince = null;

  constructor({ enterDurationMs, exitDurationMs }) {
    this.#enterDurationMs = enterDurationMs;
    this.#exitDurationMs = exitDurationMs;
  }

  reset() {
    this.#active = false;
    this.#enterSince = null;
    this.#exitSince = null;
  }

  update({ enterCondition, exitCondition, now }) {
    if (!this.#active) {
      this.#exitSince = null;
      if (!enterCondition) {
        this.#enterSince = null;
        return false;
      }

      this.#enterSince ??= now;
      if (now - this.#enterSince >= this.#enterDurationMs) {
        this.#active = true;
        this.#enterSince = null;
      }
      return this.#active;
    }

    this.#enterSince = null;
    if (!exitCondition) {
      this.#exitSince = null;
      return true;
    }

    this.#exitSince ??= now;
    if (now - this.#exitSince >= this.#exitDurationMs) {
      this.#active = false;
      this.#exitSince = null;
    }
    return this.#active;
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalPercent(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeRate(...values) {
  return values.reduce((total, value) => total + Math.max(0, finiteNumber(value)), 0);
}

export class SignalMapper {
  #clock;
  #rules;
  #lastSampleAt = null;
  #cpuGate;
  #gpuGate;
  #memoryPressureGate;
  #diskGate;
  #networkGate;

  constructor({ clock = new SystemClock(), rules = DEFAULT_SYSTEM_BEHAVIOR_RULES } = {}) {
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("clock must provide now()");
    }

    this.#clock = clock;
    this.#rules = rules;
    this.#cpuGate = new TimedHysteresisGate(rules.cpu);
    this.#gpuGate = new TimedHysteresisGate(rules.gpu);
    this.#memoryPressureGate = new TimedHysteresisGate(rules.memoryPressure);
    this.#diskGate = new TimedHysteresisGate(rules.disk);
    this.#networkGate = new TimedHysteresisGate(rules.network);
  }

  update(metrics) {
    if (!metrics || typeof metrics !== "object") {
      throw new TypeError("metrics must be an object");
    }

    const now = this.#clock.now();
    if (
      this.#lastSampleAt !== null &&
      now - this.#lastSampleAt >= this.#rules.maxSampleGapMs
    ) {
      this.#resetGates();
    }
    this.#lastSampleAt = now;

    const cpu = finiteNumber(metrics.cpuUsagePercent);
    const gpu = optionalPercent(metrics.gpuUsagePercent);
    const memory = finiteNumber(metrics.memoryUsagePercent);
    const diskBps = nonNegativeRate(metrics.diskReadBps, metrics.diskWriteBps);
    const networkBps = nonNegativeRate(metrics.networkRxBps, metrics.networkTxBps);

    const cpuBusy = this.#cpuGate.update({
      enterCondition: cpu >= this.#rules.cpu.enterPercent,
      exitCondition: cpu <= this.#rules.cpu.exitPercent,
      now,
    });
    const gpuBusy = this.#gpuGate.update({
      enterCondition: gpu !== null && gpu >= this.#rules.gpu.enterPercent,
      exitCondition: gpu === null || gpu <= this.#rules.gpu.exitPercent,
      now,
    });
    const memoryPressure = this.#memoryPressureGate.update({
      enterCondition: memory >= this.#rules.memoryPressure.enterPercent,
      exitCondition: memory <= this.#rules.memoryPressure.exitPercent,
      now,
    });
    const diskBusy = this.#diskGate.update({
      enterCondition: diskBps >= this.#rules.disk.enterBps,
      exitCondition: diskBps <= this.#rules.disk.exitBps,
      now,
    });
    const networkBusy = this.#networkGate.update({
      enterCondition: networkBps >= this.#rules.network.enterBps,
      exitCondition: networkBps <= this.#rules.network.exitBps,
      now,
    });

    return Object.freeze({
      fallback: {
        state: "idle",
        priority: DECISION_PRIORITY.idle,
        source: "system_default",
        reason: "normal system activity",
      },
      waiting: this.#waitingDecision({ metrics, cpu, gpu, memory, diskBps, networkBps }),
      load: this.#loadDecision({ cpuBusy, gpuBusy, diskBusy, networkBusy }),
      pressure: memoryPressure
        ? {
            state: "failed",
            priority: DECISION_PRIORITY.systemPressure,
            source: "memory_pressure",
            reason: "sustained memory pressure",
          }
        : null,
    });
  }

  #loadDecision({ cpuBusy, gpuBusy, diskBusy, networkBusy }) {
    if (cpuBusy || gpuBusy) {
      let source = "cpu_busy";
      if (cpuBusy && gpuBusy) {
        source = "cpu_gpu_busy";
      } else if (gpuBusy) {
        source = "gpu_busy";
      }

      return {
        state: "review",
        priority: DECISION_PRIORITY.highLoad,
        source,
        reason: "sustained compute load",
      };
    }

    if (diskBusy || networkBusy) {
      let source = "disk_active";
      if (diskBusy && networkBusy) {
        source = "disk_network_active";
      } else if (networkBusy) {
        source = "network_active";
      }

      return {
        state: "running",
        priority: DECISION_PRIORITY.highLoad,
        source,
        reason: "sustained io activity",
      };
    }

    return null;
  }

  #waitingDecision({ metrics, cpu, gpu, memory, diskBps, networkBps }) {
    if (metrics.userIdleSeconds === null || metrics.userIdleSeconds === undefined) {
      return null;
    }

    const userIdleSeconds = Number(metrics.userIdleSeconds);
    if (!Number.isFinite(userIdleSeconds)) {
      return null;
    }

    const waiting = this.#rules.waiting;
    const gpuIsLow = gpu === null || gpu <= waiting.maxGpuPercent;
    const lowActivity =
      cpu <= waiting.maxCpuPercent &&
      gpuIsLow &&
      memory <= waiting.maxMemoryPercent &&
      diskBps <= waiting.maxDiskBps &&
      networkBps <= waiting.maxNetworkBps;

    if (userIdleSeconds < waiting.userIdleSeconds || !lowActivity) {
      return null;
    }

    return {
      state: "waiting",
      priority: DECISION_PRIORITY.idle,
      source: "system_idle",
      reason: "user idle with low system activity",
    };
  }

  #resetGates() {
    this.#cpuGate.reset();
    this.#gpuGate.reset();
    this.#memoryPressureGate.reset();
    this.#diskGate.reset();
    this.#networkGate.reset();
  }
}
