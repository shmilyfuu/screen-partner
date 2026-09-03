import { createNormalizedPet, PET_STATES } from "./normalized-pet.js";

export const CODEX_V1_LAYOUT = Object.freeze({
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
});

const DURATION_TABLE = Object.freeze({
  idle: Object.freeze([1680, 660, 660, 840, 840, 1920]),
  "running-right": Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]),
  "running-left": Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]),
  waving: Object.freeze([140, 140, 140, 280]),
  jumping: Object.freeze([140, 140, 140, 140, 280]),
  failed: Object.freeze([140, 140, 140, 140, 140, 140, 140, 240]),
  waiting: Object.freeze([150, 150, 150, 150, 150, 260]),
  running: Object.freeze([120, 120, 120, 120, 120, 220]),
  review: Object.freeze([150, 150, 150, 150, 150, 280]),
});

function createFrames(row, durations) {
  return Object.freeze(
    durations.map((durationMs, column) =>
      Object.freeze({
        spriteIndex: row * CODEX_V1_LAYOUT.columns + column,
        durationMs,
      }),
    ),
  );
}

export const CODEX_DEFAULT_ANIMATIONS = Object.freeze(
  Object.fromEntries(
    PET_STATES.map((state, row) => [
      state,
      Object.freeze({ frames: createFrames(row, DURATION_TABLE[state]) }),
    ]),
  ),
);

export function createCodexDefaultPet({
  id = "codex-default",
  displayName = "Codex Default",
  spritesheetPath = "spritesheet.webp",
} = {}) {
  return createNormalizedPet({
    sourceFormat: "codex-v1",
    id,
    displayName,
    spritesheetPath,
    ...CODEX_V1_LAYOUT,
    animations: CODEX_DEFAULT_ANIMATIONS,
  });
}
