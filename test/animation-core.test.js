import assert from "node:assert/strict";
import test from "node:test";

import { AnimationPlayer } from "../src/renderer/core/animation-player.js";
import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "../src/renderer/core/behavior-arbiter.js";
import {
  CODEX_DEFAULT_ANIMATIONS,
  CODEX_V1_LAYOUT,
  createCodexDefaultPet,
} from "../src/renderer/core/codex-default-animations.js";
import { FakeClock } from "../src/renderer/core/clock.js";
import { createNormalizedPet, PET_STATES } from "../src/renderer/core/normalized-pet.js";

const EXPECTED_DURATIONS = {
  idle: [1680, 660, 660, 840, 840, 1920],
  "running-right": [120, 120, 120, 120, 120, 120, 120, 220],
  "running-left": [120, 120, 120, 120, 120, 120, 120, 220],
  waving: [140, 140, 140, 280],
  jumping: [140, 140, 140, 140, 280],
  failed: [140, 140, 140, 140, 140, 140, 140, 240],
  waiting: [150, 150, 150, 150, 150, 260],
  running: [120, 120, 120, 120, 120, 220],
  review: [150, 150, 150, 150, 150, 280],
};

function createTestPet(animationDurations) {
  const entries = Object.entries(animationDurations);
  const columns = Math.max(...entries.map(([, durations]) => durations.length));

  return createNormalizedPet({
    sourceFormat: "test",
    id: "test-pet",
    displayName: "Test Pet",
    spritesheetPath: "test.webp",
    frameWidth: 1,
    frameHeight: 1,
    columns,
    rows: entries.length,
    animations: Object.fromEntries(
      entries.map(([state, durations], row) => [
        state,
        {
          frames: durations.map((durationMs, column) => ({
            spriteIndex: row * columns + column,
            durationMs,
          })),
        },
      ]),
    ),
  });
}

test("Codex v1 layout matches the baseline spritesheet", () => {
  assert.deepEqual(CODEX_V1_LAYOUT, {
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
  });
});

test("Codex default animations preserve all nine frame timings and rows", () => {
  assert.deepEqual(Object.keys(CODEX_DEFAULT_ANIMATIONS), PET_STATES);

  PET_STATES.forEach((state, row) => {
    const frames = CODEX_DEFAULT_ANIMATIONS[state].frames;
    assert.deepEqual(
      frames.map((frame) => frame.durationMs),
      EXPECTED_DURATIONS[state],
    );
    assert.deepEqual(
      frames.map((frame) => frame.spriteIndex),
      EXPECTED_DURATIONS[state].map((_, column) => row * 8 + column),
    );
  });
});

test("Codex default pet is a valid normalized pet", () => {
  const pet = createCodexDefaultPet();
  assert.equal(pet.sourceFormat, "codex-v1");
  assert.equal(pet.animations.idle.frames.length, 6);
  assert.equal(pet.animations.failed.frames.length, 8);
});

test("AnimationPlayer gives every frame its own full deadline", () => {
  const clock = new FakeClock();
  const frames = [];
  const boundaries = [];
  const player = new AnimationPlayer({
    clock,
    longPauseThresholdMs: 10_000,
    onFrame: (frame) => frames.push(frame),
    onActionBoundary: (boundary) => boundaries.push(boundary),
  });

  player.loadPet(createTestPet({ idle: [10, 20] }));
  player.start("idle");

  assert.equal(frames.length, 1);
  assert.equal(player.getSnapshot().frameDeadline, 10);

  clock.advance(10);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 1);
  assert.equal(player.getSnapshot().frameDeadline, 30);

  clock.advance(19);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 1);
  assert.equal(boundaries.length, 0);

  clock.advance(1);
  player.tick();
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].actionCycleId, 1);
  assert.equal(player.getSnapshot().currentFrameIndex, 0);
  assert.equal(player.getSnapshot().actionCycleId, 2);
  assert.equal(player.getSnapshot().frameDeadline, 40);
});

test("AnimationPlayer advances at most one frame per tick", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 10_000 });

  player.loadPet(createTestPet({ idle: [10, 20, 30] }));
  player.start("idle");

  clock.advance(100);
  player.tick();

  assert.equal(player.getSnapshot().currentFrameIndex, 1);
  assert.equal(player.getSnapshot().frameDeadline, 120);
});

test("pending decisions switch state only after the last frame duration", () => {
  const clock = new FakeClock();
  const boundaries = [];
  const player = new AnimationPlayer({
    clock,
    longPauseThresholdMs: 10_000,
    onActionBoundary: (boundary) => boundaries.push(boundary),
  });

  player.loadPet(createTestPet({ idle: [10, 20], waving: [7, 8] }));
  player.start("idle");

  clock.advance(5);
  player.requestDecision({
    state: "waving",
    priority: DECISION_PRIORITY.interaction,
    source: "single_click",
    reason: "pet clicked",
    requestedAt: clock.now(),
  });

  assert.equal(player.getSnapshot().currentState, "idle");

  clock.advance(5);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "idle");
  assert.equal(player.getSnapshot().currentFrameIndex, 1);

  clock.advance(19);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "idle");

  clock.advance(1);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "waving");
  assert.equal(player.getSnapshot().currentFrameIndex, 0);
  assert.equal(player.getPendingDecision(), null);
  assert.equal(boundaries[0].appliedDecision.source, "single_click");
});

test("AnimationPlayer keeps only the latest arbiter result in the pending slot", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 10_000 });
  player.loadPet(createTestPet({ idle: [10], failed: [10], waiting: [10] }));
  player.start("idle");

  player.requestDecision({
    state: "failed",
    priority: DECISION_PRIORITY.systemPressure,
    source: "cpu_busy",
    reason: "cpu pressure",
    requestedAt: 1,
  });
  player.requestDecision({
    state: "waiting",
    priority: DECISION_PRIORITY.idle,
    source: "system_idle",
    reason: "system returned to idle",
    requestedAt: 2,
  });

  assert.equal(player.getPendingDecision().state, "waiting");
});

test("BehaviorArbiter chooses higher priority and falls back after continuous withdrawal", () => {
  const clock = new FakeClock();
  const arbiter = new BehaviorArbiter({ clock });

  arbiter.latchSignal("random-wave", {
    state: "waving",
    priority: DECISION_PRIORITY.random,
    source: "random_action",
    reason: "random wave",
  });

  arbiter.setContinuousSignal("cpu", {
    state: "running",
    priority: DECISION_PRIORITY.highLoad,
    source: "cpu_busy",
    reason: "cpu load is high",
  });

  assert.equal(arbiter.decide().state, "running");

  arbiter.clearContinuousSignal("cpu");
  assert.equal(arbiter.decide().state, "waving");
});

test("latched signals remain until consumed or expired", () => {
  const clock = new FakeClock();
  const arbiter = new BehaviorArbiter({ clock });
  const decision = arbiter.latchSignal(
    "double-click",
    {
      state: "jumping",
      priority: DECISION_PRIORITY.interaction,
      source: "double_click",
      reason: "pet double clicked",
    },
    10_000,
  );

  clock.advance(9000);
  assert.equal(arbiter.decide().state, "jumping");
  assert.equal(arbiter.consumeDecision(decision), true);
  assert.equal(arbiter.decide(), null);

  arbiter.latchSignal(
    "random-wave",
    {
      state: "waving",
      priority: DECISION_PRIORITY.random,
      source: "random_action",
      reason: "random wave",
    },
    1000,
  );
  clock.advance(1000);
  assert.equal(arbiter.decide(), null);
});

test("applied latched decisions can be consumed at the action boundary", () => {
  const clock = new FakeClock();
  const arbiter = new BehaviorArbiter({ clock });
  const player = new AnimationPlayer({
    clock,
    longPauseThresholdMs: 10_000,
    onActionBoundary: ({ appliedDecision }) => {
      arbiter.consumeDecision(appliedDecision);
    },
  });

  player.loadPet(createTestPet({ idle: [10], waving: [10] }));
  player.start("idle");

  arbiter.latchSignal("single-click", {
    state: "waving",
    priority: DECISION_PRIORITY.interaction,
    source: "single_click",
    reason: "pet clicked",
  });
  player.requestDecision(arbiter.decide());

  clock.advance(10);
  player.tick();

  assert.equal(player.getSnapshot().currentState, "waving");
  assert.equal(arbiter.decide(), null);
});

test("long scheduling gaps preserve the current frame remaining time", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 2500 });

  player.loadPet(createTestPet({ idle: [1000, 100] }));
  player.start("idle");

  clock.advance(400);
  player.tick();
  assert.equal(player.getSnapshot().frameDeadline, 1000);

  clock.advance(3000);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 0);
  assert.equal(player.getSnapshot().frameDeadline, 4000);

  clock.advance(599);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 0);

  clock.advance(1);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 1);
});

test("explicit suspend and resume preserve the current frame remaining time", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 10_000 });

  player.loadPet(createTestPet({ idle: [1000, 100] }));
  player.start("idle");

  clock.advance(350);
  player.suspend();
  clock.advance(5000);
  player.tick();
  player.resume();

  assert.equal(player.getSnapshot().frameDeadline, 6000);

  clock.advance(649);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 0);

  clock.advance(1);
  player.tick();
  assert.equal(player.getSnapshot().currentFrameIndex, 1);
});
