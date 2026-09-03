export class SystemClock {
  now() {
    return performance.now();
  }
}

export class FakeClock {
  #nowMs;

  constructor(initialNowMs = 0) {
    if (!Number.isFinite(initialNowMs)) {
      throw new TypeError("initialNowMs must be finite");
    }

    this.#nowMs = initialNowMs;
  }

  now() {
    return this.#nowMs;
  }

  advance(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new TypeError("deltaMs must be a non-negative finite number");
    }

    this.#nowMs += deltaMs;
    return this.#nowMs;
  }

  set(nowMs) {
    if (!Number.isFinite(nowMs) || nowMs < this.#nowMs) {
      throw new RangeError("FakeClock cannot move backwards");
    }

    this.#nowMs = nowMs;
    return this.#nowMs;
  }
}
