import { SystemClock } from "./clock.js";
import { validateNormalizedPet } from "./normalized-pet.js";

export const DEFAULT_LONG_PAUSE_THRESHOLD_MS = 2500;

export class AnimationPlayer {
  #clock;
  #onFrame;
  #onActionBoundary;
  #longPauseThresholdMs;
  #pet = null;
  #running = false;
  #suspended = false;
  #suspendedRemainingMs = 0;
  #currentState = null;
  #currentFrameIndex = 0;
  #frameStartedAt = 0;
  #frameDeadline = 0;
  #lastTickAt = 0;
  #actionCycleId = 0;

  constructor({
    clock = new SystemClock(),
    onFrame = () => {},
    onActionBoundary = () => {},
    longPauseThresholdMs = DEFAULT_LONG_PAUSE_THRESHOLD_MS,
  } = {}) {
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("clock must provide now()");
    }

    if (typeof onFrame !== "function" || typeof onActionBoundary !== "function") {
      throw new TypeError("animation callbacks must be functions");
    }

    if (!Number.isFinite(longPauseThresholdMs) || longPauseThresholdMs <= 0) {
      throw new TypeError("longPauseThresholdMs must be positive and finite");
    }

    this.#clock = clock;
    this.#onFrame = onFrame;
    this.#onActionBoundary = onActionBoundary;
    this.#longPauseThresholdMs = longPauseThresholdMs;
  }

  loadPet(pet) {
    this.#pet = validateNormalizedPet(pet);
    this.#running = false;
    this.#suspended = false;
    this.#currentState = null;
    this.#currentFrameIndex = 0;
    this.#actionCycleId = 0;
  }

  start(initialState) {
    const animation = this.#getAnimation(initialState);
    const now = this.#clock.now();

    this.#running = true;
    this.#suspended = false;
    this.#currentState = initialState;
    this.#currentFrameIndex = 0;
    this.#frameStartedAt = now;
    this.#frameDeadline = now + animation.frames[0].durationMs;
    this.#lastTickAt = now;
    this.#actionCycleId = 1;
    this.#emitFrame();

    return this.getSnapshot();
  }

  tick() {
    if (!this.#running || this.#suspended) {
      return this.getSnapshot();
    }

    const now = this.#clock.now();
    const gapMs = now - this.#lastTickAt;

    if (gapMs < 0) {
      throw new RangeError("clock moved backwards");
    }

    if (gapMs >= this.#longPauseThresholdMs) {
      this.#frameStartedAt += gapMs;
      this.#frameDeadline += gapMs;
      this.#lastTickAt = now;
      return this.getSnapshot();
    }

    this.#lastTickAt = now;

    if (now < this.#frameDeadline) {
      return this.getSnapshot();
    }

    const animation = this.#getAnimation(this.#currentState);

    if (this.#currentFrameIndex < animation.frames.length - 1) {
      this.#currentFrameIndex += 1;
      this.#frameStartedAt = now;
      this.#frameDeadline = now + animation.frames[this.#currentFrameIndex].durationMs;
      this.#emitFrame();
      return this.getSnapshot();
    }

    const completedCycleId = this.#actionCycleId;
    this.#onActionBoundary({
      state: this.#currentState,
      actionCycleId: completedCycleId,
      completedAt: now,
    });

    this.#actionCycleId += 1;
    this.#currentFrameIndex = 0;
    this.#frameStartedAt = now;
    this.#frameDeadline = now + animation.frames[0].durationMs;
    this.#emitFrame();

    return this.getSnapshot();
  }

  suspend() {
    if (!this.#running || this.#suspended) {
      return this.getSnapshot();
    }

    const now = this.#clock.now();
    this.#suspendedRemainingMs = Math.max(0, this.#frameDeadline - now);
    this.#suspended = true;
    this.#lastTickAt = now;
    return this.getSnapshot();
  }

  resume() {
    if (!this.#running || !this.#suspended) {
      return this.getSnapshot();
    }

    const now = this.#clock.now();
    const durationMs = this.#getCurrentFrame().durationMs;
    const elapsedMs = durationMs - this.#suspendedRemainingMs;

    this.#frameStartedAt = now - elapsedMs;
    this.#frameDeadline = now + this.#suspendedRemainingMs;
    this.#lastTickAt = now;
    this.#suspended = false;
    this.#suspendedRemainingMs = 0;
    return this.getSnapshot();
  }

  getSnapshot() {
    return Object.freeze({
      running: this.#running,
      suspended: this.#suspended,
      currentState: this.#currentState,
      currentFrameIndex: this.#currentFrameIndex,
      frameStartedAt: this.#frameStartedAt,
      frameDeadline: this.#frameDeadline,
      actionCycleId: this.#actionCycleId,
    });
  }

  #getAnimation(state) {
    if (!this.#pet) {
      throw new Error("loadPet() must be called before playback");
    }

    const animation = this.#pet.animations[state];
    if (!animation) {
      throw new RangeError(`unknown animation state: ${state}`);
    }

    return animation;
  }

  #getCurrentFrame() {
    const animation = this.#getAnimation(this.#currentState);
    return animation.frames[this.#currentFrameIndex];
  }

  #emitFrame() {
    this.#onFrame({
      state: this.#currentState,
      frameIndex: this.#currentFrameIndex,
      frame: this.#getCurrentFrame(),
      frameStartedAt: this.#frameStartedAt,
      frameDeadline: this.#frameDeadline,
      actionCycleId: this.#actionCycleId,
    });
  }
}
