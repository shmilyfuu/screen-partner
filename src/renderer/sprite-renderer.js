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

function scaledPixels(value, scale) {
  return value * scale;
}

function backgroundOffset(value) {
  return value === 0 ? "0px" : `-${value}px`;
}

export class SpriteRenderer {
  #element;
  #pet = null;
  #scale = 1;

  constructor(element) {
    if (!element?.style) {
      throw new TypeError("SpriteRenderer requires a styled DOM element");
    }

    this.#element = element;
  }

  setScale(scale) {
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new TypeError("scale must be a positive finite number");
    }

    this.#scale = scale;
    this.#applyPetGeometry();

    const spriteIndex = Number(this.#element.dataset.spriteIndex);
    if (this.#pet && Number.isInteger(spriteIndex)) {
      this.#applyFrameGeometry(spriteIndex);
    }

    return this.#scale;
  }

  loadPet(pet, spritesheetUrl) {
    this.#pet = validateNormalizedPet(pet);

    if (typeof spritesheetUrl !== "string" || spritesheetUrl.length === 0) {
      throw new TypeError("spritesheetUrl must be a non-empty string");
    }

    this.#element.style.backgroundImage = `url("${spritesheetUrl}")`;
    this.#element.style.backgroundRepeat = "no-repeat";
    this.#element.dataset.petId = pet.id;
    this.#applyPetGeometry();
  }

  renderFrame(frameEvent) {
    if (!this.#pet) {
      throw new Error("loadPet() must be called before renderFrame()");
    }

    const spriteIndex = frameEvent?.frame?.spriteIndex ?? frameEvent?.spriteIndex;
    this.#applyFrameGeometry(spriteIndex);
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

  #applyPetGeometry() {
    if (!this.#pet) {
      return;
    }

    const sheetWidth = this.#pet.frameWidth * this.#pet.columns;
    const sheetHeight = this.#pet.frameHeight * this.#pet.rows;
    this.#element.style.width = `${scaledPixels(this.#pet.frameWidth, this.#scale)}px`;
    this.#element.style.height = `${scaledPixels(this.#pet.frameHeight, this.#scale)}px`;
    this.#element.style.backgroundSize =
      `${scaledPixels(sheetWidth, this.#scale)}px ${scaledPixels(sheetHeight, this.#scale)}px`;
  }

  #applyFrameGeometry(spriteIndex) {
    const geometry = getSpriteFrameGeometry(this.#pet, spriteIndex);
    const x = scaledPixels(geometry.x, this.#scale);
    const y = scaledPixels(geometry.y, this.#scale);
    this.#element.style.backgroundPosition =
      `${backgroundOffset(x)} ${backgroundOffset(y)}`;
  }
}
