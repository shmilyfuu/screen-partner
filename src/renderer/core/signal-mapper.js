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
    enterPercent: 60,
    exitPercent: 50,
    enterDurationMs: 5_000,
    exitDurationMs: 4_000,
  }),
  gpu: Object.freeze({
    enterPercent: 75,
    exitPercent: 55,
    enterDurationMs: 5_000,
    exitDurationMs: 4_000,
  }),
  memoryPressure: Object.freeze({
    enterPercent: 92,
    exitPercent: 90,
    enterDurationMs: 12_000,
    exitDurationMs: 5_000,
  }),
  disk: Object.freeze({
    enterBps: 4_000_000,
    exitBps: 3_000_000,
    enterDurationMs: 3_000,
    exitDurationMs: 3_000,
  }),
  network: Object.freeze({
    enterBps: 1_500_000,
    exitBps: 750_000,
    enterDurationMs: 3_000,
    exitDurationMs: 3_000,
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

  getSnapshot(now) {
    return Object.freeze({
      active: this.#active,
      enterSince: this.#enterSince,
      exitSince: this.#exitSince,
      enterElapsedMs:
        this.#enterSince === null ? 0 : Math.max(0, now - this.#enterSince),
      exitElapsedMs:
        this.#exitSince === null ? 0 : Math.max(0, now - this.#exitSince),
    });
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

function decisionSummary(decision) {
  if (!decision) {
    return null;
  }

  return Object.freeze({
    state: decision.state,
    priority: decision.priority,
    source: decision.source,
    reason: decision.reason,
  });
}

export class SignalMapper {
  #clock;
  #rules;
  #lastSampleAt = null;
  #lastDiagnostics = null;
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
    const previousSampleAt = this.#lastSampleAt;
    const sampleGapMs = previousSampleAt === null ? null : now - previousSampleAt;
    const resetForSampleGap =
      sampleGapMs !== null && sampleGapMs >= this.#rules.maxSampleGapMs;
    if (resetForSampleGap) {
      this.#resetGates();
    }
    this.#lastSampleAt = now;

    const cpu = finiteNumber(metrics.cpuUsagePercent);
    const gpu = optionalPercent(metrics.gpuUsagePercent);
    const memory = finiteNumber(metrics.memoryUsagePercent);
    const diskReadBps = nonNegativeRate(metrics.diskReadBps);
    const diskWriteBps = nonNegativeRate(metrics.diskWriteBps);
    const diskBps = diskReadBps + diskWriteBps;
    const networkRxBps = nonNegativeRate(metrics.networkRxBps);
    const networkTxBps = nonNegativeRate(metrics.networkTxBps);
    const networkBps = networkRxBps + networkTxBps;

    const cpuEnterCondition = cpu >= this.#rules.cpu.enterPercent;
    const cpuExitCondition = cpu <= this.#rules.cpu.exitPercent;
    const gpuEnterCondition = gpu !== null && gpu >= this.#rules.gpu.enterPercent;
    const gpuExitCondition = gpu === null || gpu <= this.#rules.gpu.exitPercent;
    const memoryEnterCondition = memory >= this.#rules.memoryPressure.enterPercent;
    const memoryExitCondition = memory <= this.#rules.memoryPressure.exitPercent;
    const diskEnterCondition = diskBps >= this.#rules.disk.enterBps;
    const diskExitCondition = diskBps <= this.#rules.disk.exitBps;
    const networkEnterCondition = networkBps >= this.#rules.network.enterBps;
    const networkExitCondition = networkBps <= this.#rules.network.exitBps;

    const cpuBusy = this.#cpuGate.update({
      enterCondition: cpuEnterCondition,
      exitCondition: cpuExitCondition,
      now,
    });
    const gpuBusy = this.#gpuGate.update({
      enterCondition: gpuEnterCondition,
      exitCondition: gpuExitCondition,
      now,
    });
    const memoryPressure = this.#memoryPressureGate.update({
      enterCondition: memoryEnterCondition,
      exitCondition: memoryExitCondition,
      now,
    });
    const diskBusy = this.#diskGate.update({
      enterCondition: diskEnterCondition,
      exitCondition: diskExitCondition,
      now,
    });
    const networkBusy = this.#networkGate.update({
      enterCondition: networkEnterCondition,
      exitCondition: networkExitCondition,
      now,
    });

    const snapshot = Object.freeze({
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

    this.#lastDiagnostics = Object.freeze({
      now,
      sampleGapMs,
      resetForSampleGap,
      values: Object.freeze({
        cpuPercent: cpu,
        gpuPercent: gpu,
        memoryPercent: memory,
        diskReadBps,
        diskWriteBps,
        diskTotalBps: diskBps,
        networkRxBps,
        networkTxBps,
        networkTotalBps: networkBps,
        userIdleSeconds:
          metrics.userIdleSeconds === null || metrics.userIdleSeconds === undefined
            ? null
            : finiteNumber(metrics.userIdleSeconds, null),
      }),
      gates: Object.freeze({
        cpu: this.#gateDiagnostics({
          gate: this.#cpuGate,
          now,
          value: cpu,
          unit: "percent",
          enterCondition: cpuEnterCondition,
          exitCondition: cpuExitCondition,
          enterThreshold: this.#rules.cpu.enterPercent,
          exitThreshold: this.#rules.cpu.exitPercent,
          enterDurationMs: this.#rules.cpu.enterDurationMs,
          exitDurationMs: this.#rules.cpu.exitDurationMs,
        }),
        gpu: this.#gateDiagnostics({
          gate: this.#gpuGate,
          now,
          value: gpu,
          unit: "percent",
          enterCondition: gpuEnterCondition,
          exitCondition: gpuExitCondition,
          enterThreshold: this.#rules.gpu.enterPercent,
          exitThreshold: this.#rules.gpu.exitPercent,
          enterDurationMs: this.#rules.gpu.enterDurationMs,
          exitDurationMs: this.#rules.gpu.exitDurationMs,
        }),
        memory: this.#gateDiagnostics({
          gate: this.#memoryPressureGate,
          now,
          value: memory,
          unit: "percent",
          enterCondition: memoryEnterCondition,
          exitCondition: memoryExitCondition,
          enterThreshold: this.#rules.memoryPressure.enterPercent,
          exitThreshold: this.#rules.memoryPressure.exitPercent,
          enterDurationMs: this.#rules.memoryPressure.enterDurationMs,
          exitDurationMs: this.#rules.memoryPressure.exitDurationMs,
        }),
        disk: this.#gateDiagnostics({
          gate: this.#diskGate,
          now,
          value: diskBps,
          unit: "bytesPerSecond",
          enterCondition: diskEnterCondition,
          exitCondition: diskExitCondition,
          enterThreshold: this.#rules.disk.enterBps,
          exitThreshold: this.#rules.disk.exitBps,
          enterDurationMs: this.#rules.disk.enterDurationMs,
          exitDurationMs: this.#rules.disk.exitDurationMs,
        }),
        network: this.#gateDiagnostics({
          gate: this.#networkGate,
          now,
          value: networkBps,
          unit: "bytesPerSecond",
          enterCondition: networkEnterCondition,
          exitCondition: networkExitCondition,
          enterThreshold: this.#rules.network.enterBps,
          exitThreshold: this.#rules.network.exitBps,
          enterDurationMs: this.#rules.network.enterDurationMs,
          exitDurationMs: this.#rules.network.exitDurationMs,
        }),
      }),
      decisions: Object.freeze({
        fallback: decisionSummary(snapshot.fallback),
        waiting: decisionSummary(snapshot.waiting),
        load: decisionSummary(snapshot.load),
        pressure: decisionSummary(snapshot.pressure),
      }),
    });

    return snapshot;
  }

  getDiagnostics() {
    return this.#lastDiagnostics;
  }

  #gateDiagnostics({
    gate,
    now,
    value,
    unit,
    enterCondition,
    exitCondition,
    enterThreshold,
    exitThreshold,
    enterDurationMs,
    exitDurationMs,
  }) {
    return Object.freeze({
      ...gate.getSnapshot(now),
      value,
      unit,
      enterCondition,
      exitCondition,
      enterThreshold,
      exitThreshold,
      enterDurationMs,
      exitDurationMs,
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
