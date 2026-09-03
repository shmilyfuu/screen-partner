export const PET_STATES = Object.freeze([
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
]);

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
}

export function validateNormalizedPet(pet) {
  if (pet === null || typeof pet !== "object") {
    throw new TypeError("pet must be an object");
  }

  assertNonEmptyString(pet.sourceFormat, "sourceFormat");
  assertNonEmptyString(pet.id, "id");
  assertNonEmptyString(pet.displayName, "displayName");
  assertNonEmptyString(pet.spritesheetPath, "spritesheetPath");
  assertPositiveInteger(pet.frameWidth, "frameWidth");
  assertPositiveInteger(pet.frameHeight, "frameHeight");
  assertPositiveInteger(pet.columns, "columns");
  assertPositiveInteger(pet.rows, "rows");

  if (pet.animations === null || typeof pet.animations !== "object") {
    throw new TypeError("animations must be an object");
  }

  const animationEntries = Object.entries(pet.animations);
  if (animationEntries.length === 0) {
    throw new TypeError("animations must contain at least one animation");
  }

  const spriteCount = pet.columns * pet.rows;

  for (const [animationName, animation] of animationEntries) {
    assertNonEmptyString(animationName, "animation name");

    if (!animation || !Array.isArray(animation.frames) || animation.frames.length === 0) {
      throw new TypeError(`${animationName}.frames must contain at least one frame`);
    }

    for (const [frameIndex, frame] of animation.frames.entries()) {
      if (!Number.isInteger(frame.spriteIndex) || frame.spriteIndex < 0 || frame.spriteIndex >= spriteCount) {
        throw new RangeError(`${animationName}.frames[${frameIndex}].spriteIndex is outside the spritesheet`);
      }

      if (!Number.isFinite(frame.durationMs) || frame.durationMs <= 0) {
        throw new TypeError(`${animationName}.frames[${frameIndex}].durationMs must be positive`);
      }
    }
  }

  return pet;
}

export function createNormalizedPet(definition) {
  const animations = Object.fromEntries(
    Object.entries(definition.animations ?? {}).map(([name, animation]) => [
      name,
      Object.freeze({
        frames: Object.freeze(
          (animation.frames ?? []).map((frame) => Object.freeze({ ...frame })),
        ),
      }),
    ]),
  );

  const pet = {
    sourceFormat: definition.sourceFormat,
    id: definition.id,
    displayName: definition.displayName,
    spritesheetPath: definition.spritesheetPath,
    frameWidth: definition.frameWidth,
    frameHeight: definition.frameHeight,
    columns: definition.columns,
    rows: definition.rows,
    animations: Object.freeze(animations),
  };

  validateNormalizedPet(pet);
  return Object.freeze(pet);
}
