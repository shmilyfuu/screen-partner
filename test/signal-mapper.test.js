import assert from "node:assert/strict";
import test from "node:test";

import { BehaviorArbiter } from "../src/renderer/core/behavior-arbiter.js";
import { FakeClock } from "../src/renderer/core/clock.js";
import { SignalMapper, SYSTEM_SIGNAL_KEYS } from "../src/renderer/core/signal-mapper.js";

function metrics(overrides = {}) {
  return {
    timestampMs: 0,
    cpuUsagePercent: 10,
    gpuUsagePercent: null,
    memoryUsagePercent: 50,
    diskReadBps: 0,
    diskWriteBps: 0,
    networkRxBps: 0,
    networkTxBps: 0,
    userIdleSeconds: null,
    ...overrides,
  };
}

function applySnapshot(arbiter, snapshot) {
  for (const [name, decision] of Object.entries(snapshot)) {
    const key = SYSTEM_SIGNAL_KEYS[name];
    if (decision) {
      arbiter.setContinuousSignal(key, decision);
    } else {
      arbiter.clearContinuousSignal(key);
    }
  }
}

test("CPU busy requires sustained load and hysteresis before exit", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  let snapshot = mapper.update(metrics({ cpuUsagePercent: 80 }));
  assert.equal(snapshot.load, null);
  for (let second = 1; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 80 }));
    assert.equal(snapshot.load, null);
  }
  clock.advance(1_000);
  snapshot = mapper.update(metrics({ cpuUsagePercent: 80 }));
  assert.equal(snapshot.load.state, "review");

  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 70 })).load.state, "review");

  for (let second = 0; second < 8; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 55 }));
    assert.equal(snapshot.load.state, "review");
  }
  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 55 })).load, null);
});

test("short disk and network bursts do not trigger running", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  assert.equal(
    mapper.update(metrics({ diskReadBps: 5_000_000, networkRxBps: 2_000_000 })).load,
    null,
  );
  clock.advance(1_000);
  assert.equal(
    mapper.update(metrics({ diskReadBps: 5_000_000, networkRxBps: 2_000_000 })).load,
    null,
  );
  clock.advance(1_000);
  assert.equal(
    mapper.update(metrics({ diskReadBps: 5_000_000, networkRxBps: 2_000_000 })).load,
    null,
  );

  clock.advance(1_000);
  const load = mapper.update(
    metrics({ diskReadBps: 5_000_000, networkRxBps: 2_000_000 }),
  ).load;
  assert.equal(load.state, "running");
  assert.equal(load.source, "disk_network_active");
});

test("GPU utilization maps to review while unavailable GPU telemetry stays neutral", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  assert.equal(mapper.update(metrics({ gpuUsagePercent: null })).load, null);
  mapper.update(metrics({ gpuUsagePercent: 90 }));
  let load = null;
  for (let second = 0; second < 5; second += 1) {
    clock.advance(1_000);
    load = mapper.update(metrics({ gpuUsagePercent: 90 })).load;
  }
  assert.equal(load.state, "review");
  assert.equal(load.source, "gpu_busy");
});

test("memory pressure outranks sustained compute load", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });
  const arbiter = new BehaviorArbiter({ clock });

  let snapshot = mapper.update(metrics({ cpuUsagePercent: 85, memoryUsagePercent: 95 }));
  for (let second = 0; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 85, memoryUsagePercent: 95 }));
  }
  applySnapshot(arbiter, snapshot);
  assert.equal(arbiter.decide().state, "review");

  for (let second = 0; second < 7; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 85, memoryUsagePercent: 95 }));
  }
  applySnapshot(arbiter, snapshot);
  assert.equal(arbiter.decide().state, "failed");
  assert.equal(arbiter.decide().source, "memory_pressure");
});

test("waiting requires user idle telemetry and low system activity", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  assert.equal(mapper.update(metrics()).waiting, null);
  assert.equal(
    mapper.update(metrics({ userIdleSeconds: 60, cpuUsagePercent: 5 })).waiting.state,
    "waiting",
  );
  assert.equal(
    mapper.update(metrics({ userIdleSeconds: 60, cpuUsagePercent: 20 })).waiting,
    null,
  );
});

test("a long telemetry gap restarts dwell timers", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  mapper.update(metrics({ cpuUsagePercent: 90 }));
  clock.advance(5_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 90 })).load, null);

  clock.advance(2_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 90 })).load, null);
  clock.advance(3_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 90 })).load, null);
});
