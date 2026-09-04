import assert from "node:assert/strict";
import test from "node:test";

import { AnimationPlayer } from "../src/renderer/core/animation-player.js";
import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "../src/renderer/core/behavior-arbiter.js";
import { FakeClock } from "../src/renderer/core/clock.js";
import { createNormalizedPet } from "../src/renderer/core/normalized-pet.js";
import {
  DEFAULT_SYSTEM_BEHAVIOR_RULES,
  SignalMapper,
  SYSTEM_SIGNAL_KEYS,
} from "../src/renderer/core/signal-mapper.js";

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

function createBehaviorTestPet() {
  return createNormalizedPet({
    sourceFormat: "test",
    id: "behavior-test-pet",
    displayName: "Behavior Test Pet",
    spritesheetPath: "test.webp",
    frameWidth: 1,
    frameHeight: 1,
    columns: 1,
    rows: 2,
    animations: {
      idle: { frames: [{ spriteIndex: 0, durationMs: 10_000 }] },
      review: { frames: [{ spriteIndex: 1, durationMs: 1_000 }] },
    },
  });
}

test("system behavior defaults use the accepted Phase 4 thresholds", () => {
  assert.deepEqual(DEFAULT_SYSTEM_BEHAVIOR_RULES.cpu, {
    enterPercent: 60,
    exitPercent: 50,
    enterDurationMs: 5_000,
    exitDurationMs: 4_000,
  });
  assert.deepEqual(DEFAULT_SYSTEM_BEHAVIOR_RULES.gpu, {
    enterPercent: 75,
    exitPercent: 55,
    enterDurationMs: 5_000,
    exitDurationMs: 4_000,
  });
  assert.deepEqual(DEFAULT_SYSTEM_BEHAVIOR_RULES.disk, {
    enterBps: 4_000_000,
    exitBps: 3_000_000,
    enterDurationMs: 3_000,
    exitDurationMs: 3_000,
  });
  assert.deepEqual(DEFAULT_SYSTEM_BEHAVIOR_RULES.network, {
    enterBps: 1_500_000,
    exitBps: 750_000,
    enterDurationMs: 3_000,
    exitDurationMs: 3_000,
  });
});

test("CPU busy enters at 60 percent after five seconds and exits after four low seconds", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  let snapshot = mapper.update(metrics({ cpuUsagePercent: 60 }));
  assert.equal(snapshot.load, null);
  for (let second = 1; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 60 }));
    assert.equal(snapshot.load, null);
  }
  clock.advance(1_000);
  snapshot = mapper.update(metrics({ cpuUsagePercent: 60 }));
  assert.equal(snapshot.load.state, "review");

  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 55 })).load.state, "review");

  clock.advance(1_000);
  snapshot = mapper.update(metrics({ cpuUsagePercent: 50 }));
  assert.equal(snapshot.load.state, "review");
  for (let second = 1; second < 4; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 50 }));
    assert.equal(snapshot.load.state, "review");
  }
  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ cpuUsagePercent: 50 })).load, null);
});

test("GPU busy enters at 75 percent after five seconds", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  let snapshot = mapper.update(metrics({ gpuUsagePercent: 75 }));
  for (let second = 0; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ gpuUsagePercent: 75 }));
  }
  assert.equal(snapshot.load.state, "review");
  assert.equal(snapshot.load.source, "gpu_busy");
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

test("disk activity clears after three seconds below the recovery threshold", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  let snapshot = mapper.update(metrics({ diskWriteBps: 5_000_000 }));
  for (let second = 0; second < 3; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ diskWriteBps: 5_000_000 }));
  }
  assert.equal(snapshot.load.state, "running");

  clock.advance(1_000);
  snapshot = mapper.update(metrics({ diskWriteBps: 2_500_000 }));
  assert.equal(snapshot.load.state, "running");
  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ diskWriteBps: 2_500_000 })).load.state, "running");
  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ diskWriteBps: 2_500_000 })).load.state, "running");
  clock.advance(1_000);
  assert.equal(mapper.update(metrics({ diskWriteBps: 2_500_000 })).load, null);
});

test("unavailable GPU telemetry stays neutral", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });

  assert.equal(mapper.update(metrics({ gpuUsagePercent: null })).load, null);
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

test("debug override wins over system load and clearing it restores automatic behavior", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });
  const arbiter = new BehaviorArbiter({ clock });

  let snapshot = mapper.update(metrics({ cpuUsagePercent: 85 }));
  for (let second = 0; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 85 }));
  }
  applySnapshot(arbiter, snapshot);
  assert.equal(arbiter.decide().state, "review");

  arbiter.setContinuousSignal("debug-state", {
    state: "jumping",
    priority: DECISION_PRIORITY.interaction,
    source: "debug_menu",
    reason: "manual_state",
  });
  assert.equal(arbiter.decide().state, "jumping");

  clock.advance(1_000);
  applySnapshot(arbiter, mapper.update(metrics({ cpuUsagePercent: 85 })));
  assert.equal(arbiter.decide().state, "jumping");

  arbiter.clearContinuousSignal("debug-state");
  assert.equal(arbiter.decide().state, "review");
});

test("system metrics reach AnimationPlayer through SignalMapper and BehaviorArbiter at an action boundary", () => {
  const clock = new FakeClock();
  const mapper = new SignalMapper({ clock });
  const arbiter = new BehaviorArbiter({ clock });
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 100_000 });

  player.loadPet(createBehaviorTestPet());
  player.start("idle");

  let snapshot = mapper.update(metrics({ cpuUsagePercent: 85 }));
  for (let second = 0; second < 5; second += 1) {
    clock.advance(1_000);
    snapshot = mapper.update(metrics({ cpuUsagePercent: 85 }));
  }
  applySnapshot(arbiter, snapshot);
  player.requestDecision(arbiter.decide());

  assert.equal(player.getSnapshot().currentState, "idle");
  assert.equal(player.getPendingDecision().state, "review");

  clock.advance(4_999);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "idle");

  clock.advance(1);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "review");
});
