import { PET_STATES } from "./normalized-pet.js";

export const DECISION_PRIORITY = Object.freeze({
  interaction: 0,
  systemPressure: 1,
  highLoad: 2,
  external: 3,
  random: 4,
  idle: 5,
});

export const DEFAULT_LATCH_TTL_MS = 10_000;

function assertSignalKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("signal key must be a non-empty string");
  }
}

function assertDecisionText(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

export function createPendingDecision(decision, requestedAt) {
  if (!decision || typeof decision !== "object") {
    throw new TypeError("decision must be an object");
  }

  if (!PET_STATES.includes(decision.state)) {
    throw new RangeError(`unknown pet state: ${decision.state}`);
  }

  if (!Number.isFinite(decision.priority) || decision.priority < 0) {
    throw new TypeError("priority must be a non-negative finite number");
  }

  assertDecisionText(decision.source, "source");
  assertDecisionText(decision.reason, "reason");

  const resolvedRequestedAt = decision.requestedAt ?? requestedAt;
  if (!Number.isFinite(resolvedRequestedAt)) {
    throw new TypeError("requestedAt must be finite");
  }

  return Object.freeze({
    state: decision.state,
    priority: decision.priority,
    source: decision.source,
    reason: decision.reason,
    requestedAt: resolvedRequestedAt,
  });
}

export class BehaviorArbiter {
  #clock;
  #continuousSignals = new Map();
  #latchedSignals = new Map();
  #sequence = 0;

  constructor({ clock } = {}) {
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("clock must provide now()");
    }

    this.#clock = clock;
  }

  setContinuousSignal(key, decision) {
    assertSignalKey(key);
    const normalized = createPendingDecision(decision, this.#clock.now());

    this.#continuousSignals.set(key, {
      decision: normalized,
      sequence: ++this.#sequence,
    });

    return normalized;
  }

  clearContinuousSignal(key) {
    assertSignalKey(key);
    return this.#continuousSignals.delete(key);
  }

  latchSignal(key, decision, ttlMs = DEFAULT_LATCH_TTL_MS) {
    assertSignalKey(key);

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive and finite");
    }

    const now = this.#clock.now();
    const normalized = createPendingDecision(decision, now);

    this.#latchedSignals.set(key, {
      decision: normalized,
      expiresAt: now + ttlMs,
      sequence: ++this.#sequence,
    });

    return normalized;
  }

  clearLatchedSignal(key) {
    assertSignalKey(key);
    return this.#latchedSignals.delete(key);
  }

  decide() {
    this.#pruneExpiredLatchedSignals();

    let winner = null;

    for (const candidate of this.#continuousSignals.values()) {
      winner = this.#pickWinner(winner, candidate);
    }

    for (const candidate of this.#latchedSignals.values()) {
      winner = this.#pickWinner(winner, candidate);
    }

    return winner?.decision ?? null;
  }

  consumeDecision(decision) {
    if (!decision) {
      return false;
    }

    this.#pruneExpiredLatchedSignals();

    for (const [key, candidate] of this.#latchedSignals.entries()) {
      if (this.#sameDecision(candidate.decision, decision)) {
        this.#latchedSignals.delete(key);
        return true;
      }
    }

    return false;
  }

  #pruneExpiredLatchedSignals() {
    const now = this.#clock.now();

    for (const [key, candidate] of this.#latchedSignals.entries()) {
      if (now >= candidate.expiresAt) {
        this.#latchedSignals.delete(key);
      }
    }
  }

  #pickWinner(current, candidate) {
    if (!current) {
      return candidate;
    }

    if (candidate.decision.priority < current.decision.priority) {
      return candidate;
    }

    if (
      candidate.decision.priority === current.decision.priority &&
      candidate.sequence > current.sequence
    ) {
      return candidate;
    }

    return current;
  }

  #sameDecision(left, right) {
    return (
      left.state === right.state &&
      left.priority === right.priority &&
      left.source === right.source &&
      left.reason === right.reason &&
      left.requestedAt === right.requestedAt
    );
  }
}
