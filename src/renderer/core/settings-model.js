export const SETTINGS_SCHEMA_VERSION = 2;
export const PET_SCALE_OPTIONS = Object.freeze([0.75, 1, 1.25, 1.5]);

export const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  petScale: 1,
  alwaysOnTop: true,
  randomBehaviorEnabled: true,
  systemAwarenessEnabled: true,
  launchAtStartup: false,
});

function booleanOrDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizedPetScale(value) {
  const number = Number(value);
  return PET_SCALE_OPTIONS.includes(number)
    ? number
    : DEFAULT_DESKTOP_SETTINGS.petScale;
}

export function normalizeDesktopSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    petScale: normalizedPetScale(source.petScale),
    alwaysOnTop: booleanOrDefault(
      source.alwaysOnTop,
      DEFAULT_DESKTOP_SETTINGS.alwaysOnTop,
    ),
    randomBehaviorEnabled: booleanOrDefault(
      source.randomBehaviorEnabled,
      DEFAULT_DESKTOP_SETTINGS.randomBehaviorEnabled,
    ),
    systemAwarenessEnabled: booleanOrDefault(
      source.systemAwarenessEnabled,
      DEFAULT_DESKTOP_SETTINGS.systemAwarenessEnabled,
    ),
    launchAtStartup: booleanOrDefault(
      source.launchAtStartup,
      DEFAULT_DESKTOP_SETTINGS.launchAtStartup,
    ),
  });
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const windowPosition =
    source.window &&
    Number.isInteger(source.window.x) &&
    Number.isInteger(source.window.y)
      ? Object.freeze({ x: source.window.x, y: source.window.y })
      : null;

  return Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    window: windowPosition,
    desktop: normalizeDesktopSettings(source.desktop),
  });
}
