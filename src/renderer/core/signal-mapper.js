import { DECISION_PRIORITY } from "./behavior-arbiter.js";
import { SystemClock } from "./clock.js";
import {
  DEFAULT_SYSTEM_BEHAVIOR_RULES,
  DiskActivityGate,
  TimedHysteresisGate,
  decisionSummary,
  finiteNumber,
  nonNegativeRate,
  normalizeCursorFeedback,
  optionalNumber,
  optionalPercent,
  optionalString,
} from "./signal-rules-gates.js";

export { DEFAULT_SYSTEM_BEHAVIOR_RULES, SYSTEM_SIGNAL_KEYS } from "./signal-rules-gates.js";
import { SYSTEM_SIGNAL_KEYS } from "./signal-rules-gates.js";

export class SignalMapper {
  #clock;
  #rules;
  #lastSampleAt = null;
  #lastDiagnostics = null;
  #cpuGate;
  #gpuGate;
  #memoryPressureGate;
  #diskActivityGate;
  #diskPressureGate;
  #networkGate;
  #cursorBusyGate;
  #cursorBackgroundGate;

  constructor({ clock = new SystemClock(), rules = DEFAULT_SYSTEM_BEHAVIOR_RULES } = {}) {
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("clock must provide now()");
    }

    this.#clock = clock;
    this.#rules = rules;
    this.#cpuGate = new TimedHysteresisGate(rules.cpu);
    this.#gpuGate = new TimedHysteresisGate(rules.gpu);
    this.#memoryPressureGate = new TimedHysteresisGate(rules.memoryPressure);
    this.#diskActivityGate = new DiskActivityGate({
      diskRules: rules.disk,
      activityRules: rules.diskActivity,
    });
    this.#diskPressureGate = new TimedHysteresisGate(rules.diskPressure);
    this.#networkGate = new TimedHysteresisGate(rules.network);
    this.#cursorBusyGate = new TimedHysteresisGate({
      enterDurationMs: 0,
      exitDurationMs: rules.cursorFeedback.exitDurationMs,
    });
    this.#cursorBackgroundGate = new TimedHysteresisGate({
      enterDurationMs: 0,
      exitDurationMs: rules.cursorFeedback.exitDurationMs,
    });
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
    const diskBusyPercent = optionalPercent(metrics.diskBusyPercent);
    const diskLatencyMs = optionalNumber(metrics.diskLatencyMs);
    const networkRxBps = nonNegativeRate(metrics.networkRxBps);
    const networkTxBps = nonNegativeRate(metrics.networkTxBps);
    const networkBps = networkRxBps + networkTxBps;
    const cursorFeedback = normalizeCursorFeedback(metrics.cursorFeedback);

    const cpuEnterCondition = cpu >= this.#rules.cpu.enterPercent;
    const cpuExitCondition = cpu <= this.#rules.cpu.exitPercent;
    const gpuEnterCondition = gpu !== null && gpu >= this.#rules.gpu.enterPercent;
    const gpuExitCondition = gpu === null || gpu <= this.#rules.gpu.exitPercent;
    const memoryEnterCondition = memory >= this.#rules.memoryPressure.enterPercent;
    const memoryExitCondition = memory <= this.#rules.memoryPressure.exitPercent;
    const diskPressureEnterCondition =
      (diskBusyPercent !== null &&
        diskBusyPercent >= this.#rules.diskPressure.enterPercent) ||
      (diskLatencyMs !== null &&
        diskLatencyMs >= this.#rules.diskPressure.enterLatencyMs);
    const diskPressureExitCondition =
      (diskBusyPercent === null ||
        diskBusyPercent <= this.#rules.diskPressure.exitPercent) &&
      (diskLatencyMs === null ||
        diskLatencyMs <= this.#rules.diskPressure.exitLatencyMs);
    const networkEnterCondition = networkBps >= this.#rules.network.enterBps;
    const networkExitCondition = networkBps <= this.#rules.network.exitBps;
    const cursorBusyEnterCondition = cursorFeedback === "busy";
    const cursorBusyExitCondition = cursorFeedback !== "busy";
    const cursorBackgroundEnterCondition = cursorFeedback === "background_working";
    const cursorBackgroundExitCondition = cursorFeedback !== "background_working";

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
    const diskActivity = this.#diskActivityGate.update({ valueBps: diskBps, now });
    const diskPressure = this.#diskPressureGate.update({
      enterCondition: diskPressureEnterCondition,
      exitCondition: diskPressureExitCondition,
      now,
    });
    const networkBusy = this.#networkGate.update({
      enterCondition: networkEnterCondition,
      exitCondition: networkExitCondition,
      now,
    });
    const cursorBusy = this.#cursorBusyGate.update({
      enterCondition: cursorBusyEnterCondition,
      exitCondition: cursorBusyExitCondition,
      now,
    });
    const cursorBackground = this.#cursorBackgroundGate.update({
      enterCondition: cursorBackgroundEnterCondition,
      exitCondition: cursorBackgroundExitCondition,
      now,
    });

    const diskSnapshot = this.#diskActivityGate.getSnapshot(now);
    const diskExitCondition = diskBps <= diskSnapshot.exitThresholdBps;
    const diskEnterCondition = diskBps >= this.#rules.disk.enterBps;

    const snapshot = Object.freeze({
      fallback: {
        state: "idle",
        priority: DECISION_PRIORITY.idle,
        source: "system_default",
        reason: "normal system activity",
      },
      waiting: this.#waitingDecision({ metrics, cpu, gpu, memory, diskBps, networkBps }),
      load: this.#loadDecision({
        cursorBackground,
        cpuBusy,
        gpuBusy,
        diskActivity,
        diskPressure,
        networkBusy,
      }),
      pressure: this.#pressureDecision({ memoryPressure, cursorBusy }),
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
        diskBusyPercent,
        diskLatencyMs,
        diskActivityDevice: optionalString(metrics.diskActivityDevice),
        diskPressureDevice: optionalString(metrics.diskPressureDevice),
        networkRxBps,
        networkTxBps,
        networkTotalBps: networkBps,
        networkActivityInterface: optionalString(metrics.networkActivityInterface),
        cursorFeedback,
        cursorFeedbackDetail: optionalString(metrics.cursorFeedbackDetail),
        cursorFeedbackToken: optionalNumber(metrics.cursorFeedbackToken),
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
        disk: Object.freeze({
          ...diskSnapshot,
          value: diskBps,
          unit: "bytesPerSecond",
          enterCondition: diskEnterCondition,
          exitCondition: diskExitCondition,
          enterThreshold: this.#rules.disk.enterBps,
          exitThreshold: diskSnapshot.exitThresholdBps,
          exitFloorThreshold: this.#rules.disk.exitBps,
          enterDurationMs: this.#rules.disk.enterDurationMs,
          exitDurationMs: this.#rules.disk.exitDurationMs,
        }),
        diskPressure: this.#gateDiagnostics({
          gate: this.#diskPressureGate,
          now,
          value: diskBusyPercent,
          unit: "percent",
          enterCondition: diskPressureEnterCondition,
          exitCondition: diskPressureExitCondition,
          enterThreshold: this.#rules.diskPressure.enterPercent,
          exitThreshold: this.#rules.diskPressure.exitPercent,
          enterDurationMs: this.#rules.diskPressure.enterDurationMs,
          exitDurationMs: this.#rules.diskPressure.exitDurationMs,
          latencyMs: diskLatencyMs,
          enterLatencyMs: this.#rules.diskPressure.enterLatencyMs,
          exitLatencyMs: this.#rules.diskPressure.exitLatencyMs,
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
        cursorBusy: this.#gateDiagnostics({
          gate: this.#cursorBusyGate,
          now,
          value: cursorFeedback,
          unit: "cursorFeedback",
          enterCondition: cursorBusyEnterCondition,
          exitCondition: cursorBusyExitCondition,
          enterThreshold: "busy",
          exitThreshold: "not_busy",
          enterDurationMs: 0,
          exitDurationMs: this.#rules.cursorFeedback.exitDurationMs,
        }),
        cursorBackground: this.#gateDiagnostics({
          gate: this.#cursorBackgroundGate,
          now,
          value: cursorFeedback,
          unit: "cursorFeedback",
          enterCondition: cursorBackgroundEnterCondition,
          exitCondition: cursorBackgroundExitCondition,
          enterThreshold: "background_working",
          exitThreshold: "not_background_working",
          enterDurationMs: 0,
          exitDurationMs: this.#rules.cursorFeedback.exitDurationMs,
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
    ...extra
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
      ...extra,
    });
  }

  #pressureDecision({ memoryPressure, cursorBusy }) {
    if (memoryPressure) {
      return {
        state: "failed",
        priority: DECISION_PRIORITY.systemPressure,
        source: "memory_pressure",
        reason: "sustained memory pressure",
      };
    }

    if (cursorBusy) {
      return {
        state: "waiting",
        priority: DECISION_PRIORITY.systemPressure,
        source: "cursor_busy",
        reason: "system busy cursor feedback",
      };
    }

    return null;
  }

  #loadDecision({
    cursorBackground,
    cpuBusy,
    gpuBusy,
    diskActivity,
    diskPressure,
    networkBusy,
  }) {
    if (cursorBackground) {
      return {
        state: "running",
        priority: DECISION_PRIORITY.highLoad,
        source: "cursor_background_working",
        reason: "system background-working cursor feedback",
      };
    }

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

    const diskBusy = diskActivity || diskPressure;
    if (diskBusy || networkBusy) {
      let source = diskPressure ? "disk_pressure" : "disk_active";
      if (diskBusy && networkBusy) {
        source = diskPressure ? "disk_pressure_network_active" : "disk_network_active";
      } else if (networkBusy) {
        source = "network_active";
      }

      return {
        state: "running",
        priority: DECISION_PRIORITY.highLoad,
        source,
        reason: diskPressure ? "disk pressure or io activity" : "sustained io activity",
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
    this.#diskActivityGate.reset();
    this.#diskPressureGate.reset();
    this.#networkGate.reset();
    this.#cursorBusyGate.reset();
    this.#cursorBackgroundGate.reset();
  }
}
