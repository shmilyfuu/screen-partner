import assert from "node:assert/strict";
import test from "node:test";

import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "../src/renderer/core/behavior-arbiter.js";
import { FakeClock } from "../src/renderer/core/clock.js";
import {
  DEFAULT_RANDOM_BEHAVIOR_RULES,
  RandomBehavior,
  RANDOM_SIGNAL_KEY,
} from "../src/renderer/core/random-behavior.js";

function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("random sequence exhausted");
    }
    return value;
  };
}

test("default random behavior preserves the documented 30-120s schedule and weights", () => {
  assert.equal(DEFAULT_RANDOM_BEHAVIOR_RULES.minIntervalMs, 30_000);
  assert.equal(DEFAULT_RANDOM_BEHAVIOR_RULES.maxIntervalMs, 120_000);
  assert.deepEqual(
    DEFAULT_RANDOM_BEHAVIOR_RULES.actions.map(({ state, weight }) => [state, weight]),
    [
      ["waving", 35],
      ["jumping", 20],
      ["waiting", 20],
      ["review", 10],
      ["idle", 15],
    ],
  );
});

test("poll emits one P4 latched decision only when its random deadline is reached", () => {
  const clock = new FakeClock();
  const randomBehavior = new RandomBehavior({
    clock,
    random: sequenceRandom([0, 0, 0]),
  });

  assert.equal(randomBehavior.start(), 30_000);
  clock.advance(29_999);
  assert.equal(randomBehavior.poll(), null);

  clock.advance(1);
  const event = randomBehavior.poll();
  assert.equal(event.type, "decision");
  assert.equal(event.decision.state, "waving");
  assert.equal(event.decision.priority, DECISION_PRIORITY.random);
  assert.equal(event.decision.source, "random_behavior");
  assert.equal(event.latchTtlMs, 10_000);
  assert.equal(event.nextDueAt, 60_000);
});

test("weighted selection follows the documented cumulative weights", () => {
  const cases = [
    [0.0, "waving"],
    [0.3499, "waving"],
    [0.35, "jumping"],
    [0.5499, "jumping"],
    [0.55, "waiting"],
    [0.7499, "waiting"],
    [0.75, "review"],
    [0.8499, "review"],
    [0.85, "idle"],
    [0.9999, "idle"],
  ];

  for (const [selection, expectedState] of cases) {
    const clock = new FakeClock();
    const randomBehavior = new RandomBehavior({
      clock,
      random: sequenceRandom([0, selection, 0]),
    });
    randomBehavior.start();
    clock.advance(30_000);
    assert.equal(randomBehavior.poll().decision.state, expectedState);
  }
});

test("a due random action is suppressed and fully rescheduled under higher priority work", () => {
  const clock = new FakeClock();
  const randomBehavior = new RandomBehavior({
    clock,
    random: sequenceRandom([0, 0.5]),
  });

  randomBehavior.start();
  clock.advance(30_000);
  const event = randomBehavior.poll({ blocked: true });

  assert.equal(event.type, "suppressed");
  assert.equal(event.scheduledFor, 30_000);
  assert.equal(event.nextDueAt, 105_000);
  assert.equal(randomBehavior.getDiagnostics().lastTriggeredAt, null);
});

test("cooldown remains an independent floor when configured above the minimum interval", () => {
  const clock = new FakeClock();
  const randomBehavior = new RandomBehavior({
    clock,
    random: sequenceRandom([0, 0, 0, 0]),
    rules: {
      minIntervalMs: 10_000,
      maxIntervalMs: 10_000,
      cooldownMs: 25_000,
      actions: [{ state: "waving", weight: 1 }],
    },
  });

  assert.equal(randomBehavior.start(), 25_000);
  clock.advance(25_000);
  assert.equal(randomBehavior.poll().type, "decision");
  assert.equal(randomBehavior.getDiagnostics().nextDueAt, 50_000);
});

test("reschedule discards an already pending random deadline", () => {
  const clock = new FakeClock();
  const randomBehavior = new RandomBehavior({
    clock,
    random: sequenceRandom([0, 1 / 3]),
  });

  assert.equal(randomBehavior.start(), 30_000);
  clock.advance(10_000);
  assert.equal(randomBehavior.reschedule(), 70_000);
  clock.advance(20_000);
  assert.equal(randomBehavior.poll(), null);
});

test("clearing a random latch when P2 work arrives prevents delayed replay after recovery", () => {
  const clock = new FakeClock();
  const arbiter = new BehaviorArbiter({ clock });
  const randomBehavior = new RandomBehavior({
    clock,
    random: sequenceRandom([0, 0, 0, 0]),
  });

  randomBehavior.start();
  clock.advance(30_000);
  const event = randomBehavior.poll();
  arbiter.latchSignal(RANDOM_SIGNAL_KEY, event.decision, event.latchTtlMs);
  assert.equal(arbiter.decide().source, "random_behavior");

  arbiter.setContinuousSignal("cpu", {
    state: "review",
    priority: DECISION_PRIORITY.highLoad,
    source: "cpu_busy",
    reason: "cpu busy",
  });
  assert.equal(arbiter.decide().source, "cpu_busy");

  assert.equal(arbiter.clearLatchedSignal(RANDOM_SIGNAL_KEY), true);
  randomBehavior.reschedule();
  arbiter.clearContinuousSignal("cpu");
  assert.equal(arbiter.decide(), null);
});
