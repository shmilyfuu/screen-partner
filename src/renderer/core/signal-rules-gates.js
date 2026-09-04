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
  diskActivity: Object.freeze({
    exitPeakRatio: 0.15,
    rearmQuietDurationMs: 5_000,
    reentryMinBps: 64_000_000,
    reentryPeakRatio: 0.25,
  }),
  diskPressure: Object.freeze({
    enterPercent: 70,
    exitPercent: 35,
    enterLatencyMs: 20,
    exitLatencyMs: 8,
    enterDurationMs: 2_000,
    exitDurationMs: 2_000,
  }),
  network: Object.freeze({
    enterBps: 1_500_000,
    exitBps: 750_000,
    enterDurationMs: 3_000,
    exitDurationMs: 3_000,
  }),
  cursorFeedback: Object.freeze({
    exitDurationMs: 1_000,
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

export class TimedHysteresisGate {
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

export class DiskActivityGate {
  #rules;
  #active = false;
  #draining = false;
  #enterSince = null;
  #exitSince = null;
  #quietSince = null;
  #candidatePeakBps = 0;
  #peakBps = 0;
  #lastPeakBps = 0;
  #valueBps = 0;

  constructor({ diskRules, activityRules }) {
    this.#rules = Object.freeze({ ...diskRules, ...activityRules });
  }

  reset() {
    this.#active = false;
    this.#draining = false;
    this.#enterSince = null;
    this.#exitSince = null;
    this.#quietSince = null;
    this.#candidatePeakBps = 0;
    this.#peakBps = 0;
    this.#lastPeakBps = 0;
    this.#valueBps = 0;
  }

  update({ valueBps, now }) {
    this.#valueBps = Math.max(0, finiteNumber(valueBps));

    if (this.#active) {
      this.#enterSince = null;
      this.#quietSince = null;
      this.#peakBps = Math.max(this.#peakBps, this.#valueBps);
      const exitThresholdBps = this.#exitThresholdBps();

      if (this.#valueBps <= exitThresholdBps) {
        this.#exitSince ??= now;
        if (now - this.#exitSince >= this.#rules.exitDurationMs) {
          this.#active = false;
          this.#draining = true;
          this.#lastPeakBps = this.#peakBps;
          this.#peakBps = 0;
          this.#exitSince = null;
          this.#quietSince = this.#valueBps <= this.#rules.exitBps ? now : null;
        }
      } else {
        this.#exitSince = null;
      }

      return this.#active;
    }

    this.#exitSince = null;
    this.#candidatePeakBps = 0;

    if (this.#draining) {
      const reentryThresholdBps = this.#reentryThresholdBps();
      if (this.#valueBps >= reentryThresholdBps) {
        this.#draining = false;
        this.#quietSince = null;
        this.#lastPeakBps = 0;
      } else {
        if (this.#valueBps <= this.#rules.exitBps) {
          this.#quietSince ??= now;
          if (now - this.#quietSince >= this.#rules.rearmQuietDurationMs) {
            this.#draining = false;
            this.#quietSince = null;
            this.#lastPeakBps = 0;
          }
        } else {
          this.#quietSince = null;
        }

        if (this.#draining) {
          this.#enterSince = null;
          return false;
        }
      }
    }

    this.#quietSince = null;
    if (this.#valueBps < this.#rules.enterBps) {
      this.#enterSince = null;
      return false;
    }

    this.#enterSince ??= now;
    this.#candidatePeakBps = Math.max(this.#candidatePeakBps, this.#valueBps);
    if (now - this.#enterSince >= this.#rules.enterDurationMs) {
      this.#active = true;
      this.#peakBps = this.#candidatePeakBps;
      this.#candidatePeakBps = 0;
      this.#enterSince = null;
    }

    return this.#active;
  }

  getSnapshot(now) {
    return Object.freeze({
      active: this.#active,
      draining: this.#draining,
      enterSince: this.#enterSince,
      exitSince: this.#exitSince,
      quietSince: this.#quietSince,
      enterElapsedMs:
        this.#enterSince === null ? 0 : Math.max(0, now - this.#enterSince),
      exitElapsedMs:
        this.#exitSince === null ? 0 : Math.max(0, now - this.#exitSince),
      quietElapsedMs:
        this.#quietSince === null ? 0 : Math.max(0, now - this.#quietSince),
      candidatePeakBps: this.#candidatePeakBps,
      peakBps: this.#peakBps,
      lastPeakBps: this.#lastPeakBps,
      exitThresholdBps: this.#exitThresholdBps(),
      reentryThresholdBps: this.#reentryThresholdBps(),
    });
  }

  #exitThresholdBps() {
    const peak = this.#active ? this.#peakBps : this.#lastPeakBps;
    return Math.max(this.#rules.exitBps, peak * this.#rules.exitPeakRatio);
  }

  #reentryThresholdBps() {
    return Math.max(
      this.#rules.reentryMinBps,
      this.#lastPeakBps * this.#rules.reentryPeakRatio,
    );
  }
}

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function optionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function optionalPercent(value) {
  const number = optionalNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

export function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function nonNegativeRate(...values) {
  return values.reduce((total, value) => total + Math.max(0, finiteNumber(value)), 0);
}

export function normalizeCursorFeedback(value) {
  switch (value) {
    case "busy":
    case "background_working":
    case "normal":
    case "other":
    case "unavailable":
      return value;
    default:
      return "unavailable";
  }
}

export function decisionSummary(decision) {
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
