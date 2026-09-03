import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_V1_SPRITESHEET_HEIGHT,
  CODEX_V1_SPRITESHEET_WIDTH,
  loadCodexV1Pet,
  normalizeCodexV1Manifest,
  normalizePetAssetPath,
  resolvePetAssetUrl,
} from "../src/renderer/codex-v1-manifest.js";
import {
  getSpriteFrameGeometry,
  SpriteRenderer,
} from "../src/renderer/sprite-renderer.js";

test("Codex v1 manifest defaults normalize to the 8x9 layout", () => {
  const pet = normalizeCodexV1Manifest(
    {
      id: "sample",
      displayName: "Sample",
      spritesheetPath: "spritesheet.webp",
    },
    { fallbackId: "fallback" },
  );

  assert.equal(pet.sourceFormat, "codex-v1");
  assert.equal(pet.id, "sample");
  assert.equal(pet.frameWidth, 192);
  assert.equal(pet.frameHeight, 208);
  assert.equal(pet.columns, 8);
  assert.equal(pet.rows, 9);
  assert.equal(CODEX_V1_SPRITESHEET_WIDTH, 1536);
  assert.equal(CODEX_V1_SPRITESHEET_HEIGHT, 1872);
  assert.equal(pet.animations.idle.frames[0].durationMs, 1680);
  assert.equal(pet.animations.review.frames.at(-1).durationMs, 280);
});

test("custom Codex v1 animation fps becomes per-frame duration", () => {
  const pet = normalizeCodexV1Manifest({
    id: "custom",
    animations: {
      waving: {
        frames: [24, 25, 26],
        fps: 10,
        loop: false,
        fallback: "idle",
      },
    },
  });

  assert.deepEqual(
    pet.animations.waving.frames.map((frame) => frame.spriteIndex),
    [24, 25, 26],
  );
  assert.deepEqual(
    pet.animations.waving.frames.map((frame) => frame.durationMs),
    [100, 100, 100],
  );
  assert.equal(pet.animations.idle.frames.length, 6);
});

test("asset paths stay inside the pet directory", () => {
  assert.equal(
    normalizePetAssetPath("./assets\\spritesheet.webp"),
    "assets/spritesheet.webp",
  );

  for (const invalid of [
    "../spritesheet.webp",
    "assets/../../spritesheet.webp",
    "/tmp/spritesheet.webp",
    "C:\\pets\\spritesheet.webp",
    "https://example.com/spritesheet.webp",
  ]) {
    assert.throws(() => normalizePetAssetPath(invalid));
  }
});

test("custom frame grids must cover the Codex v1 spritesheet", () => {
  const pet = normalizeCodexV1Manifest({
    id: "tall",
    frame: {
      width: 384,
      height: 104,
      columns: 4,
      rows: 18,
    },
  });

  assert.equal(pet.frameWidth, 384);
  assert.equal(pet.frameHeight, 104);
  assert.equal(pet.columns, 4);
  assert.equal(pet.rows, 18);

  assert.throws(() =>
    normalizeCodexV1Manifest({
      id: "bad",
      frame: {
        width: 192,
        height: 208,
        columns: 7,
        rows: 9,
      },
    }),
  );
});

test("sprite geometry maps linear indices to the correct grid cells", () => {
  const pet = normalizeCodexV1Manifest({ id: "geometry" });

  assert.deepEqual(getSpriteFrameGeometry(pet, 0), {
    column: 0,
    row: 0,
    x: 0,
    y: 0,
    sheetWidth: 1536,
    sheetHeight: 1872,
  });
  assert.equal(getSpriteFrameGeometry(pet, 7).x, 1344);
  assert.equal(getSpriteFrameGeometry(pet, 8).y, 208);
  assert.deepEqual(
    {
      x: getSpriteFrameGeometry(pet, 71).x,
      y: getSpriteFrameGeometry(pet, 71).y,
    },
    { x: 1344, y: 1664 },
  );
});

test("SpriteRenderer applies frame dimensions and background offsets", () => {
  const style = {};
  const dataset = {};
  const element = { style, dataset };
  const pet = normalizeCodexV1Manifest({ id: "render" });
  const renderer = new SpriteRenderer(element);

  renderer.loadPet(pet, "asset:///spritesheet.webp");
  renderer.renderFrame({
    state: "running-right",
    frame: { spriteIndex: 9, durationMs: 120 },
  });

  assert.equal(style.width, "192px");
  assert.equal(style.height, "208px");
  assert.equal(style.backgroundSize, "1536px 1872px");
  assert.equal(style.backgroundPosition, "-192px -208px");
  assert.equal(dataset.petId, "render");
  assert.equal(dataset.spriteIndex, "9");
  assert.equal(dataset.state, "running-right");
});

test("loadCodexV1Pet resolves assets relative to pet.json and validates dimensions", async () => {
  const manifestUrl = "https://app.local/pets/cat/pet.json";
  const requested = [];

  const loaded = await loadCodexV1Pet(manifestUrl, {
    fetchImpl: async (url) => {
      requested.push(url);
      return {
        ok: true,
        async json() {
          return {
            id: "cat",
            spritesheetPath: "art/spritesheet.webp",
          };
        },
      };
    },
    imageDimensions: async (url) => {
      requested.push(url);
      return { width: 1536, height: 1872 };
    },
  });

  assert.equal(requested[0], manifestUrl);
  assert.equal(
    requested[1],
    "https://app.local/pets/cat/art/spritesheet.webp",
  );
  assert.equal(loaded.pet.id, "cat");
  assert.equal(
    loaded.spritesheetUrl,
    "https://app.local/pets/cat/art/spritesheet.webp",
  );

  assert.equal(
    resolvePetAssetUrl(manifestUrl, "./art/spritesheet.webp"),
    "https://app.local/pets/cat/art/spritesheet.webp",
  );
});

test("loadCodexV1Pet rejects a spritesheet with incompatible dimensions", async () => {
  await assert.rejects(
    () =>
      loadCodexV1Pet("https://app.local/pet.json", {
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return { id: "bad-size" };
          },
        }),
        imageDimensions: async () => ({ width: 100, height: 100 }),
      }),
    /spritesheet must be 1536x1872/,
  );
});
