import {
  CODEX_DEFAULT_ANIMATIONS,
  CODEX_V1_LAYOUT,
} from "./core/codex-default-animations.js";
import { createNormalizedPet } from "./core/normalized-pet.js";

export const CODEX_V1_SPRITESHEET_WIDTH =
  CODEX_V1_LAYOUT.frameWidth * CODEX_V1_LAYOUT.columns;
export const CODEX_V1_SPRITESHEET_HEIGHT =
  CODEX_V1_LAYOUT.frameHeight * CODEX_V1_LAYOUT.rows;

const MAX_PET_FRAMES = 256;
const MAX_ANIMATION_FPS = 60;
const DEFAULT_ANIMATION_FPS = 8;

function assertObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function normalizePetAssetPath(value = "spritesheet.webp") {
  const rawPath = nonEmptyString(value);
  if (!rawPath) {
    throw new TypeError("spritesheetPath must be a non-empty relative path");
  }

  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath) ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(rawPath)
  ) {
    throw new RangeError("spritesheetPath must stay inside the pet directory");
  }

  const normalized = rawPath.replaceAll("\\", "/");
  const parts = normalized.split("/");

  if (parts.some((part) => part === "..")) {
    throw new RangeError("spritesheetPath must stay inside the pet directory");
  }

  const cleanPath = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (cleanPath.length === 0) {
    throw new TypeError("spritesheetPath must name a file");
  }

  return cleanPath;
}

function normalizeFrameSpec(frame) {
  const spec = frame ?? CODEX_V1_LAYOUT;
  assertObject(spec, "frame");

  const normalized = {
    frameWidth: spec.width ?? spec.frameWidth,
    frameHeight: spec.height ?? spec.frameHeight,
    columns: spec.columns,
    rows: spec.rows,
  };

  for (const [fieldName, value] of Object.entries(normalized)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`frame.${fieldName} must be a positive integer`);
    }
  }

  const sheetWidth = normalized.frameWidth * normalized.columns;
  const sheetHeight = normalized.frameHeight * normalized.rows;
  const frameCount = normalized.columns * normalized.rows;

  if (
    sheetWidth !== CODEX_V1_SPRITESHEET_WIDTH ||
    sheetHeight !== CODEX_V1_SPRITESHEET_HEIGHT
  ) {
    throw new RangeError(
      `frame grid must cover ${CODEX_V1_SPRITESHEET_WIDTH}x${CODEX_V1_SPRITESHEET_HEIGHT}`,
    );
  }

  if (frameCount > MAX_PET_FRAMES) {
    throw new RangeError(`frame count must not exceed ${MAX_PET_FRAMES}`);
  }

  return Object.freeze({ ...normalized, frameCount });
}

function normalizeAnimation(name, spec, frameCount) {
  assertObject(spec, `animations.${name}`);

  if (!Array.isArray(spec.frames) || spec.frames.length === 0) {
    throw new TypeError(`animations.${name}.frames must contain at least one frame`);
  }

  const fps = spec.fps ?? DEFAULT_ANIMATION_FPS;
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_ANIMATION_FPS) {
    throw new RangeError(
      `animations.${name}.fps must be greater than 0 and at most ${MAX_ANIMATION_FPS}`,
    );
  }

  const durationMs = 1000 / fps;
  const frames = spec.frames.map((spriteIndex, frameIndex) => {
    if (
      !Number.isInteger(spriteIndex) ||
      spriteIndex < 0 ||
      spriteIndex >= frameCount
    ) {
      throw new RangeError(
        `animations.${name}.frames[${frameIndex}] is outside the spritesheet`,
      );
    }

    return Object.freeze({ spriteIndex, durationMs });
  });

  return Object.freeze({ frames: Object.freeze(frames) });
}

function normalizeAnimations(specs, frameCount) {
  if (specs !== undefined) {
    assertObject(specs, "animations");
  }

  const animations = { ...CODEX_DEFAULT_ANIMATIONS };

  for (const [name, spec] of Object.entries(specs ?? {})) {
    const animationName = nonEmptyString(name);
    if (!animationName) {
      throw new TypeError("animation names must be non-empty");
    }

    animations[animationName] = normalizeAnimation(
      animationName,
      spec,
      frameCount,
    );
  }

  return animations;
}

export function normalizeCodexV1Manifest(
  manifest,
  { fallbackId = "pet" } = {},
) {
  assertObject(manifest, "manifest");

  const safeFallbackId = nonEmptyString(fallbackId) ?? "pet";
  const id = nonEmptyString(manifest.id) ?? safeFallbackId;
  const displayName =
    nonEmptyString(manifest.displayName) ??
    nonEmptyString(manifest.id) ??
    safeFallbackId;
  const spritesheetPath = normalizePetAssetPath(
    manifest.spritesheetPath ?? "spritesheet.webp",
  );
  const frame = normalizeFrameSpec(manifest.frame);
  const animations = normalizeAnimations(manifest.animations, frame.frameCount);

  return createNormalizedPet({
    sourceFormat: "codex-v1",
    id,
    displayName,
    spritesheetPath,
    frameWidth: frame.frameWidth,
    frameHeight: frame.frameHeight,
    columns: frame.columns,
    rows: frame.rows,
    animations,
  });
}

function defaultBaseUrl() {
  return globalThis.location?.href ?? "http://localhost/";
}

function fallbackIdFromManifestUrl(manifestUrl) {
  const directoryUrl = new URL("./", manifestUrl);
  const segments = directoryUrl.pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? "pet";
}

export function resolvePetAssetUrl(manifestUrl, assetPath) {
  const manifest = new URL(manifestUrl, defaultBaseUrl());
  const directory = new URL("./", manifest);
  return new URL(normalizePetAssetPath(assetPath), directory).href;
}

export function loadImageDimensions(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image !== "function") {
      reject(new Error("Image API is unavailable"));
      return;
    }

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => {
      reject(new Error(`failed to load spritesheet: ${url}`));
    };
    image.src = url;
  });
}

export async function loadCodexV1Pet(
  manifestUrl,
  {
    fetchImpl = globalThis.fetch,
    imageDimensions = loadImageDimensions,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const resolvedManifestUrl = new URL(manifestUrl, defaultBaseUrl());
  const response = await fetchImpl(resolvedManifestUrl.href);

  if (!response?.ok) {
    throw new Error(
      `failed to load pet manifest: ${resolvedManifestUrl.href}`,
    );
  }

  const manifest = await response.json();
  const pet = normalizeCodexV1Manifest(manifest, {
    fallbackId: fallbackIdFromManifestUrl(resolvedManifestUrl),
  });
  const spritesheetUrl = resolvePetAssetUrl(
    resolvedManifestUrl,
    pet.spritesheetPath,
  );
  const dimensions = await imageDimensions(spritesheetUrl);

  if (
    dimensions.width !== CODEX_V1_SPRITESHEET_WIDTH ||
    dimensions.height !== CODEX_V1_SPRITESHEET_HEIGHT
  ) {
    throw new RangeError(
      `spritesheet must be ${CODEX_V1_SPRITESHEET_WIDTH}x${CODEX_V1_SPRITESHEET_HEIGHT}`,
    );
  }

  if (
    pet.frameWidth * pet.columns !== dimensions.width ||
    pet.frameHeight * pet.rows !== dimensions.height
  ) {
    throw new RangeError("frame grid must cover the spritesheet exactly");
  }

  return Object.freeze({ pet, spritesheetUrl });
}
