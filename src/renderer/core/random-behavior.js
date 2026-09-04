import {
  DECISION_PRIORITY,
  DEFAULT_LATCH_TTL_MS,
} from "./behavior-arbiter.js";
import { PET_STATES } from "./normalized-pet.js";

export const RANDOM_SIGNAL_KEY = "random-behavior";

const DEFAULT_ACTIONS = Object.freeze([
  Object.freeze({ state: "waving", weight: 35 }),
  Object.freeze({ state: "jumping", weight: 20 }),
  Object.freeze({ state: "waiting", weight: 20 }),
  Object.freeze({ state: "review", weight: 10 }),
  Object.freeze({ state: "idle", weight: 15 }),
]);

export const DEFAULT_RANDOM_BEHAVIOR_RULES = Object.freeze({
  enabled: true,
  minIntervalMs: 30_000,
  maxIntervalMs: 120_000,
  cooldownMs: 30_000,
  latchTtlMs: DEFAULT_LATCH_TTL_MS,
  actions: DEFAULT_ACTIONS,
});

function assertFiniteNonNegative(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative finite number`);
  }
}

function normalizeRules(overrides = {}) {
  const rules = {
    ...DEFAULT_RANDOM_BEHAVIOR_RULES,
    ...overrides,
    actions: overrides.actions ?? DEFAULT_RANDOM_BEHAVIOR_RULES.actions,
  };

  if (typeof rules.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }

  assertFiniteNonNegative(rules.minIntervalMs, "minIntervalMs");
  assertFiniteNonNegative(rules.maxIntervalMs, "maxIntervalMs");
  assertFiniteNonNegative(rules.cooldownMs, "cooldownMs");

  if (rules.maxIntervalMs < rules.minIntervalMs) {
    throw new RangeError(
      "maxIntervalMs must be greater than or equal to minIntervalMs",
    );
  }
  if (!Number.isFinite(rules.latchTtlMs) || rules.latchTtlMs <= 0) {
    throw new TypeError("latchTtlMs must be positive and finite");
  }
  if (!Array.isArray(rules.actions) || rules.actions.length === 0) {
    throw new TypeError("actions must contain at least one weighted action");
  }

  let totalWeight = 0;
  const actions = rules.actions.map((action, index) => {
    if (!action || typeof action !== "object") {
      throw new TypeError(`actions[${index}] must be an object`);
    }
    if (!PET_STATES.includes(action.state)) {
      throw new RangeError(
        `actions[${index}] has unknown pet state: ${action.state}`,
      );
    }
    if (!Number.isFinite(action.weight) || action.weight <= 0) {
      throw new TypeError(
        `actions[${index}].weight must be positive and finite`,
      );
    }

    totalWeight += action.weight;
    return Object.freeze({ state: action.state, weight: action.weight });
  });

  if (!(totalWeight > 0)) {
    throw new TypeError("actions must have a positive total weight");
  }

  return Object.freeze({
    enabled: rules.enabled,
    minIntervalMs: rules.minIntervalMs,
    maxIntervalMs: rules.maxIntervalMs,
    cooldownMs: rules.cooldownMs,
    latchTtlMs: rules.latchTtlMs,
    actions: Object.freeze(actions),
    totalWeight,
  });
}

export class RandomBehavior {
  #clock;
  #random;
  #rules;
  #nextDueAt = null;
  #lastTriggeredAt = null;

  constructor({ clock, random = Math.random, rules } = {}) {
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("clock must provide now()");
    }
    if (typeof random !== "function") {
      throw new TypeError("random must be a function");
    }

    this.#clock = clock;
    this.#random = random;
    this.#rules = normalizeRules(rules);
  }

  start() {
    this.#scheduleNext(this.#clock.now());
    return this.#nextDueAt;
  }

  reset() {
    this.#nextDueAt = null;
    this.#lastTriggeredAt = null;
  }

  reschedule() {
    this.#scheduleNext(this.#clock.now());
    return this.#nextDueAt;
  }

  poll({ blocked = false } = {}) {
    if (typeof blocked !== "boolean") {
      throw new TypeError("blocked must be a boolean");
    }

    const now = this.#clock.now();
    if (!this.#rules.enabled) {
      return null;
    }
    if (this.#nextDueAt === null) {
      this.#scheduleNext(now);
      return null;
    }
    if (now < this.#nextDueAt) {
      return null;
    }

    const scheduledFor = this.#nextDueAt;

    if (blocked) {
      this.#scheduleNext(now);
      return Object.freeze({
        type: "suppressed",
        scheduledFor,
        nextDueAt: this.#nextDueAt,
      });
    }

    if (
      this.#lastTriggeredAt !== null &&
      now - this.#lastTriggeredAt < this.#rules.cooldownMs
    ) {
      this.#nextDueAt = this.#lastTriggeredAt + this.#rules.cooldownMs;
      return Object.freeze({
        type: "cooldown",
        scheduledFor,
        nextDueAt: this.#nextDueAt,
      });
    }

    const action = this.#chooseWeightedAction();
    this.#lastTriggeredAt = now;
    this.#scheduleNext(now);

    return Object.freeze({
      type: "decision",
      scheduledFor,
      nextDueAt: this.#nextDueAt,
      latchTtlMs: this.#rules.latchTtlMs,
      decision: Object.freeze({
        state: action.state,
        priority: DECISION_PRIORITY.random,
        source: "random_behavior",
        reason: `weighted_random:${action.state}`,
      }),
    });
  }

  getDiagnostics() {
    return Object.freeze({
      enabled: this.#rules.enabled,
      minIntervalMs: this.#rules.minIntervalMs,
      maxIntervalMs: this.#rules.maxIntervalMs,
      cooldownMs: this.#rules.cooldownMs,
      latchTtlMs: this.#rules.latchTtlMs,
      nextDueAt: this.#nextDueAt,
      lastTriggeredAt: this.#lastTriggeredAt,
      actions: this.#rules.actions,
    });
  }

  #scheduleNext(now) {
    const span = this.#rules.maxIntervalMs - this.#rules.minIntervalMs;
    const delay = this.#rules.minIntervalMs + span * this.#nextRandom();
    this.#nextDueAt = now + Math.max(delay, this.#rules.cooldownMs);
  }

  #chooseWeightedAction() {
    let cursor = this.#nextRandom() * this.#rules.totalWeight;

    for (const action of this.#rules.actions) {
      cursor -= action.weight;
      if (cursor < 0) {
        return action;
      }
    }

    return this.#rules.actions[this.#rules.actions.length - 1];
  }

  #nextRandom() {
    const value = this.#random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("random() must return a finite value in [0, 1)");
    }
    return value;
  }
}
