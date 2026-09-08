import assert from "node:assert/strict";
import test from "node:test";

import {
  BehaviorArbiter,
  DECISION_PRIORITY,
} from "../src/renderer/core/behavior-arbiter.js";
import { FakeClock } from "../src/renderer/core/clock.js";

test("active drag stays P0 above live system behavior until release", () => {
  const clock = new FakeClock();
  const arbiter = new BehaviorArbiter({ clock });

  arbiter.setContinuousSignal("cpu", {
    state: "review",
    priority: DECISION_PRIORITY.highLoad,
    source: "cpu_busy",
    reason: "cpu load is high",
  });

  arbiter.setContinuousSignal("dragging", {
    state: "running-left",
    priority: DECISION_PRIORITY.interaction,
    source: "dragging",
    reason: "drag_start",
  });

  assert.equal(arbiter.decide().state, "running-left");
  assert.equal(arbiter.decide().source, "dragging");

  arbiter.setContinuousSignal("dragging", {
    state: "running-right",
    priority: DECISION_PRIORITY.interaction,
    source: "dragging",
    reason: "drag_direction",
  });

  assert.equal(arbiter.decide().state, "running-right");

  arbiter.clearContinuousSignal("dragging");

  assert.equal(arbiter.decide().state, "review");
  assert.equal(arbiter.decide().source, "cpu_busy");
});
