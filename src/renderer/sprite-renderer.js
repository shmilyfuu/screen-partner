import { validateNormalizedPet } from "./core/normalized-pet.js";

export function getSpriteFrameGeometry(pet, spriteIndex) {
  validateNormalizedPet(pet);

  const frameCount = pet.columns * pet.rows;
  if (
    !Number.isInteger(spriteIndex) ||
    spriteIndex < 0 ||
    spriteIndex >= frameCount
  ) {
    throw new RangeError("spriteIndex is outside the spritesheet");
  }

  const column = spriteIndex % pet.columns;
  const row = Math.floor(spriteIndex / pet.columns);

  return Object.freeze({
    column,
    row,
    x: column * pet.frameWidth,
    y: row * pet.frameHeight,
    sheetWidth: pet.columns * pet.frameWidth,
    sheetHeight: pet.rows * pet.frameHeight,
  });
}

function backgroundOffset(value) {
  return value === 0 ? "0px" : `-${value}px`;
}

export class SpriteRenderer {
  #element;
  #pet = null;

  constructor(element) {
    if (!element?.style) {
      throw new TypeError("SpriteRenderer requires a styled DOM element");
    }

    this.#element = element;
  }

  loadPet(pet, spritesheetUrl) {
    this.#pet = validateNormalizedPet(pet);

    if (typeof spritesheetUrl !== "string" || spritesheetUrl.length === 0) {
      throw new TypeError("spritesheetUrl must be a non-empty string");
    }

    const sheetWidth = pet.frameWidth * pet.columns;
    const sheetHeight = pet.frameHeight * pet.rows;

    this.#element.style.width = `${pet.frameWidth}px`;
    this.#element.style.height = `${pet.frameHeight}px`;
    this.#element.style.backgroundImage = `url("${spritesheetUrl}")`;
    this.#element.style.backgroundSize = `${sheetWidth}px ${sheetHeight}px`;
    this.#element.style.backgroundRepeat = "no-repeat";
    this.#element.dataset.petId = pet.id;
  }

  renderFrame(frameEvent) {
    if (!this.#pet) {
      throw new Error("loadPet() must be called before renderFrame()");
    }

    const spriteIndex = frameEvent?.frame?.spriteIndex ?? frameEvent?.spriteIndex;
    const geometry = getSpriteFrameGeometry(this.#pet, spriteIndex);

    this.#element.style.backgroundPosition =
      `${backgroundOffset(geometry.x)} ${backgroundOffset(geometry.y)}`;
    this.#element.dataset.spriteIndex = String(spriteIndex);
    this.#element.dataset.state = frameEvent?.state ?? "";
  }

  clear() {
    this.#pet = null;
    this.#element.style.backgroundImage = "";
    this.#element.style.backgroundPosition = "";
    this.#element.style.backgroundSize = "";
    delete this.#element.dataset.petId;
    delete this.#element.dataset.spriteIndex;
    delete this.#element.dataset.state;
  }
}
