import assert from "node:assert/strict";
import test from "node:test";

import { AnimationPlayer } from "../src/renderer/core/animation-player.js";
import { DECISION_PRIORITY } from "../src/renderer/core/behavior-arbiter.js";
import { FakeClock } from "../src/renderer/core/clock.js";
import { createNormalizedPet } from "../src/renderer/core/normalized-pet.js";

function createPet() {
  return createNormalizedPet({
    sourceFormat: "test",
    id: "click-test",
    displayName: "Click Test",
    spritesheetPath: "test.webp",
    frameWidth: 1,
    frameHeight: 1,
    columns: 2,
    rows: 2,
    animations: {
      review: {
        frames: [{ spriteIndex: 0, durationMs: 100 }],
      },
      waving: {
        frames: [
          { spriteIndex: 1, durationMs: 20 },
          { spriteIndex: 2, durationMs: 30 },
        ],
      },
      jumping: {
        frames: [{ spriteIndex: 3, durationMs: 40 }],
      },
    },
  });
}

function systemReviewDecision(clock) {
  return {
    state: "review",
    priority: DECISION_PRIORITY.highLoad,
    source: "cpu_busy",
    reason: "test high load",
    requestedAt: clock.now(),
  };
}

test("recognized single click interrupts immediately, completes once, then restores live behavior", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 10_000 });
  player.loadPet(createPet());
  player.start("review");

  clock.advance(35);
  player.interruptState("waving");
  player.requestDecision(systemReviewDecision(clock));

  assert.equal(player.getSnapshot().currentState, "waving");
  assert.equal(player.getSnapshot().currentFrameIndex, 0);

  clock.advance(20);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "waving");
  assert.equal(player.getSnapshot().currentFrameIndex, 1);

  clock.advance(30);
  player.tick();
  assert.equal(player.getSnapshot().currentState, "review");
  assert.equal(player.getSnapshot().currentFrameIndex, 0);
});

test("drag-style interruption discards an active click action and its restore target", () => {
  const clock = new FakeClock();
  const player = new AnimationPlayer({ clock, longPauseThresholdMs: 10_000 });
  player.loadPet(createPet());
  player.start("review");

  player.interruptState("jumping");
  player.requestDecision(systemReviewDecision(clock));
  player.interruptState("waving");

  assert.equal(player.getSnapshot().currentState, "waving");
  assert.equal(player.getPendingDecision(), null);
});
