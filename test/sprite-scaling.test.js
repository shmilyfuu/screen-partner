import assert from "node:assert/strict";
import test from "node:test";

import { SpriteRenderer } from "../src/renderer/sprite-renderer.js";

function createElement() {
  return { style: {}, dataset: {} };
}

function createPet() {
  return {
    sourceFormat: "test",
    id: "scale-test",
    displayName: "Scale Test",
    spritesheetPath: "./spritesheet.webp",
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
    animations: {
      idle: {
        frames: [{ spriteIndex: 9, durationMs: 100 }],
      },
    },
  };
}

test("sprite scale updates element, sheet, and frame offsets together", () => {
  const element = createElement();
  const renderer = new SpriteRenderer(element);
  renderer.setScale(1.5);
  renderer.loadPet(createPet(), "./spritesheet.webp");
  renderer.renderFrame({ state: "idle", frame: { spriteIndex: 9 } });

  assert.equal(element.style.width, "288px");
  assert.equal(element.style.height, "312px");
  assert.equal(element.style.backgroundSize, "2304px 2808px");
  assert.equal(element.style.backgroundPosition, "-288px -312px");
});

test("changing scale after rendering reapplies the current frame", () => {
  const element = createElement();
  const renderer = new SpriteRenderer(element);
  renderer.loadPet(createPet(), "./spritesheet.webp");
  renderer.renderFrame({ state: "idle", frame: { spriteIndex: 9 } });
  renderer.setScale(0.75);

  assert.equal(element.style.width, "144px");
  assert.equal(element.style.height, "156px");
  assert.equal(element.style.backgroundPosition, "-144px -156px");
});
